import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import { AgentUnavailable } from '../protocol/errors.js';
import { configPathForDisplay } from '../protocol/paths.js';
import type { AgentInfo } from '../protocol/schema.js';
import { AgentRuntime, ShellyConfig } from './services.js';

/** Which agents exist, which one is the default, and changing it. */
export class AgentDirectory extends Context.Service<
  AgentDirectory,
  {
    readonly list: Effect.Effect<readonly AgentInfo[]>;
    /** The configured default, else the runtime's, else the first available agent. */
    readonly defaultAgentId: Effect.Effect<string>;
    /** The agent to use for a request that may name one. */
    readonly resolve: (agentId: string | undefined) => Effect.Effect<string>;
    /**
     * The agent for a fast request that may name one: the default agent when
     * it has a fast mode, else the first available agent that does, else the
     * default (whose request then says why it can't).
     */
    readonly resolveFast: (agentId: string | undefined) => Effect.Effect<string>;
    /** Like `resolve`, but fails when the agent is unknown or cannot be used now. */
    readonly requireAvailable: (agentId: string | undefined) => Effect.Effect<AgentInfo, AgentUnavailable>;
    readonly setDefault: (agentId: string) => Effect.Effect<void, AgentUnavailable>;
  }
>()('shelly/daemon/AgentDirectory') {}

export const FALLBACK_AGENT_ID = 'claude';

/** What to do when there is no agent at all: where to add one, and where to look. */
export const noAgentMessage = (env: NodeJS.ProcessEnv = process.env): string =>
  `No agent is set up. Install Claude Code or OpenCode, or add an agent to ${configPathForDisplay(env)} · /agent shows what Shelly found.`;

export const layer: Layer.Layer<AgentDirectory, never, AgentRuntime | ShellyConfig> = Layer.effect(
  AgentDirectory,
  Effect.gen(function* () {
    const runtime = yield* AgentRuntime;
    const config = yield* ShellyConfig;

    const pickDefault = (agents: readonly AgentInfo[], configured: string | undefined): string =>
      configured
      ?? agents.find((agent) => agent.isDefault)?.id
      ?? agents.find((agent) => agent.available)?.id
      ?? agents[0]?.id
      ?? FALLBACK_AGENT_ID;

    const defaultAgentId = Effect.gen(function* () {
      const [agents, file] = yield* Effect.all([runtime.agents, config.get]);
      return pickDefault(agents, file.defaultAgent);
    });

    const resolve = (agentId: string | undefined) => (agentId ? Effect.succeed(agentId) : defaultAgentId);

    const resolveFast = (agentId: string | undefined) =>
      agentId
        ? Effect.succeed(agentId)
        : Effect.gen(function* () {
          const [agents, file] = yield* Effect.all([runtime.agents, config.get]);
          const fallback = pickDefault(agents, file.defaultAgent);
          const preferred = agents.find((agent) => agent.id === fallback);
          if (preferred?.supportsFast && preferred.available) {
            return fallback;
          }
          return agents.find((agent) => agent.supportsFast && agent.available)?.id ?? fallback;
        });

    const find = Effect.fn('AgentDirectory.find')(function* (agentId: string) {
      const agents = yield* runtime.agents;
      const agent = agents.find((candidate) => candidate.id === agentId);
      if (!agent) {
        const reason = agents.length === 0
          ? noAgentMessage()
          : `Shelly does not know an agent called "${agentId}".`;
        return yield* new AgentUnavailable({ agentId, reason });
      }
      return agent;
    });

    const requireAvailable = Effect.fn('AgentDirectory.requireAvailable')(function* (agentId: string | undefined) {
      const agent = yield* find(yield* resolve(agentId));
      if (!agent.available) {
        return yield* new AgentUnavailable({
          agentId: agent.id,
          reason: agent.unavailableReason ?? `${agent.name} cannot be used right now.`,
        });
      }
      return agent;
    });

    const setDefault = Effect.fn('AgentDirectory.setDefault')(function* (agentId: string) {
      yield* find(agentId);
      yield* config.setDefaultAgent(agentId);
    });

    return AgentDirectory.of({ list: runtime.agents, defaultAgentId, resolve, resolveFast, requireAvailable, setDefault });
  }),
);
