import { join } from 'node:path';
import * as Cause from 'effect/Cause';
import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Queue from 'effect/Queue';
import * as Stream from 'effect/Stream';
import { AgentFailed, AgentUnavailable } from '../../protocol/errors.js';
import { shellyPaths } from '../../protocol/paths.js';
import type { FastEvent } from '../../protocol/schema.js';
import { type ConfigFile, FastService, ShellyConfig } from '../services.js';
import { makeClaudeBackend } from './claude-worker.js';
import { FastPool } from './pool.js';
import { buildFastMessage, FAST_SYSTEM_PROMPT } from './prompt.js';
import { classifyReply } from './reply.js';
import type { FastBackend, WorkerFailure } from './worker.js';

/*
 * FastService: fast mode's requests, run on warm workers from FastPool.
 * Each agent with a fast mode has a backend module; adding one (OpenCode)
 * is a new module and a case in `backendFor`.
 */

export interface FastSettingsValue {
  /** Scratch space for workers; each backend gets an empty folder in it. */
  readonly fastHome: string;
  readonly keepWarmMs: number;
  readonly sessionIdleMs: number;
  /** How many fast conversations keep their worker at once; each costs about 200 MB. */
  readonly maxSessions: number;
  /** A request with no output from its worker for this long fails. */
  readonly noOutputTimeoutMs: number;
  /** The claude executable, a path or a name on PATH; null finds `claude`. */
  readonly claudeExecutable: string | null;
  /** The environment workers start from, before each backend cleans it. */
  readonly env: NodeJS.ProcessEnv;
}

export const KEEP_WARM_MS = 5 * 60_000;
export const SESSION_IDLE_MS = 2 * 60_000;
export const MAX_SESSIONS = 2;
export const NO_OUTPUT_TIMEOUT_MS = 20_000;
const DEFAULT_CLAUDE_MODEL = 'haiku';

const millis = (value: string | undefined, fallback: number): number => {
  const parsed = value === undefined ? Number.NaN : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};

/** The defaults, with `SHELLY_FAST_*_MS` overrides for tests and tuning. */
export const fastSettingsFromEnv = (env: NodeJS.ProcessEnv): FastSettingsValue => ({
  fastHome: shellyPaths(env).fastHome,
  keepWarmMs: millis(env.SHELLY_FAST_KEEP_WARM_MS, KEEP_WARM_MS),
  sessionIdleMs: millis(env.SHELLY_FAST_SESSION_IDLE_MS, SESSION_IDLE_MS),
  maxSessions: MAX_SESSIONS,
  noOutputTimeoutMs: millis(env.SHELLY_FAST_TIMEOUT_MS, NO_OUTPUT_TIMEOUT_MS),
  claudeExecutable: null,
  env,
});

export const FastSettings = Context.Reference<FastSettingsValue>('shelly/daemon/fast/FastSettings', {
  defaultValue: () => fastSettingsFromEnv(process.env),
});

const AGENT_NAMES: Record<string, string> = { claude: 'Claude Code', opencode: 'OpenCode' };

const backendFor = (
  agentId: string,
  config: ConfigFile,
  settings: FastSettingsValue,
): FastBackend | AgentUnavailable => {
  const agent = config.agents?.[agentId];
  const name = agent?.name ?? AGENT_NAMES[agentId] ?? agentId;
  if (agent?.enabled === false) {
    return new AgentUnavailable({ agentId, reason: `${name} is turned off in Shelly's config.` });
  }
  switch (agentId) {
    case 'claude':
      return makeClaudeBackend({
        executable: settings.claudeExecutable,
        model: agent?.fastModel ?? DEFAULT_CLAUDE_MODEL,
        cwd: join(settings.fastHome, 'claude'),
        env: settings.env,
        systemPrompt: FAST_SYSTEM_PROMPT,
        noOutputTimeoutMs: settings.noOutputTimeoutMs,
      });
    default:
      return new AgentUnavailable({ agentId, reason: `Fast mode isn't available for ${name} yet.` });
  }
};

const toError = (agentId: string, failure: WorkerFailure): AgentUnavailable | AgentFailed =>
  failure.kind === 'unavailable'
    ? new AgentUnavailable({ agentId, reason: failure.reason })
    : new AgentFailed({ agentId, reason: failure.reason });

const make = Effect.gen(function* () {
  const config = yield* ShellyConfig;
  const settings = yield* FastSettings;
  const pool = new FastPool({
    keepWarmMs: settings.keepWarmMs,
    sessionIdleMs: settings.sessionIdleMs,
    maxSessions: settings.maxSessions,
  });
  yield* Effect.addFinalizer(() => Effect.promise(() => pool.close()));

  const resolve = Effect.fnUntraced(function* (agentId: string) {
    const backend = backendFor(agentId, yield* config.get, settings);
    return backend instanceof AgentUnavailable ? yield* backend : backend;
  });

  const request: FastService['Service']['request'] = ({ agentId, sessionKey, input }) =>
    Stream.unwrap(
      Effect.map(resolve(agentId), (backend) =>
        Stream.callback<FastEvent, AgentUnavailable | AgentFailed>((queue) =>
          Effect.acquireRelease(
            Effect.sync(() => {
              const startedAt = performance.now();
              return pool.request(agentId, backend, sessionKey, buildFastMessage(input), {
                onDelta: (text) => {
                  Queue.offerUnsafe(queue, { type: 'delta', text });
                },
                onDone: (raw) => {
                  const reply = classifyReply(raw);
                  const durationMs = Math.round(performance.now() - startedAt);
                  Queue.offerUnsafe(queue, { type: 'done', text: reply.text, kind: reply.kind, durationMs });
                  Queue.endUnsafe(queue);
                },
                onFailure: (failure) => {
                  Queue.failCauseUnsafe(queue, Cause.fail(toError(agentId, failure)));
                },
              });
            }),
            // Runs when the stream ends for any reason; after `done` it does nothing.
            (turn) => Effect.sync(() => turn.cancel()),
          ),
        ),
      ),
    ).pipe(Stream.withSpan('FastService.request', { attributes: { agentId } }));

  const prewarm: FastService['Service']['prewarm'] = Effect.fn('FastService.prewarm')(function* (agentId: string) {
    const backend = backendFor(agentId, yield* config.get, settings);
    if (!(backend instanceof AgentUnavailable)) pool.prewarm(agentId, backend);
  });

  return FastService.of({
    request,
    prewarm,
    end: (sessionKey) => Effect.sync(() => pool.end(sessionKey)),
    workerCount: Effect.sync(() => pool.workerCount),
  });
});

export const layer = Layer.effect(FastService, make);
