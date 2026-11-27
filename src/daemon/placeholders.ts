import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Stream from 'effect/Stream';
import { AgentUnavailable } from '../protocol/errors.js';
import type { AgentInfo } from '../protocol/schema.js';
import { AgentRuntime, FastService } from './services.js';

/*
 * Stand-ins so the daemon runs before agent mode (src/daemon/agents/) and
 * fast mode (src/daemon/fast/) land: every agent reports that it is not set
 * up yet, and every request fails with AgentUnavailable.
 */

const REASON = 'Agent support is not set up yet.';

const AGENTS: readonly AgentInfo[] = [
  { id: 'claude', name: 'Claude Code', available: false, unavailableReason: REASON, supportsFast: false, isDefault: true },
  { id: 'opencode', name: 'OpenCode', available: false, unavailableReason: REASON, supportsFast: false, isDefault: false },
];

export const agentRuntimeLayer: Layer.Layer<AgentRuntime> = Layer.succeed(
  AgentRuntime,
  AgentRuntime.of({
    agents: Effect.succeed(AGENTS),
    session: (request) => Effect.fail(new AgentUnavailable({ agentId: request.agentId, reason: REASON })),
    prewarm: () => Effect.void,
    release: () => Effect.void,
    processCount: Effect.succeed(0),
  }),
);

export const fastServiceLayer: Layer.Layer<FastService> = Layer.succeed(
  FastService,
  FastService.of({
    request: (request) => Stream.fail(new AgentUnavailable({ agentId: request.agentId, reason: REASON })),
    prewarm: () => Effect.void,
    end: () => Effect.void,
    workerCount: Effect.succeed(0),
  }),
);

export const layer: Layer.Layer<AgentRuntime | FastService> = Layer.mergeAll(agentRuntimeLayer, fastServiceLayer);
