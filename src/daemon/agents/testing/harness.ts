import { join } from 'node:path';
import * as NodeServices from '@effect/platform-node/NodeServices';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Stream from 'effect/Stream';
import { AgentRuntime, type AgentSessionRequest, type AgentSettings, type AgentUpdate, type ConfigFile, ShellyConfig } from '../../services.js';
import * as Runtime from '../runtime.js';

/*
 * Runs the real AgentRuntime against test agents: the fake ACP agent (wrapped
 * by quirk-agent.ts) or a recorded session (replay-peer.ts).
 */

const TSX = import.meta.resolve('tsx');
const HERE = import.meta.dirname;
export const FIXTURES = join(HERE, '..', '..', '..', '..', 'test', 'fixtures', 'acp');

const nodeAgent = (script: string, args: readonly string[], env: Record<string, string>, name?: string): AgentSettings => ({
  ...(name ? { name } : {}),
  command: process.execPath,
  args: ['--import', TSX, join(HERE, script), ...args],
  env,
});

/** The fake agent playing `scenario`, with quirk-agent's env switches. */
export const fakeAgent = (scenario: string, quirks: Record<string, string> = {}, name?: string): AgentSettings =>
  nodeAgent('quirk-agent.ts', [], { QUIRK_SCENARIO: scenario, ...quirks }, name);

/** A recorded session, e.g. `claude/tool`. */
export const replayAgent = (fixture: string, name?: string): AgentSettings =>
  nodeAgent('replay-peer.ts', [join(FIXTURES, `${fixture}.ndjson`)], {}, name);

export const configLayer = (file: ConfigFile): Layer.Layer<ShellyConfig> =>
  Layer.succeed(ShellyConfig, ShellyConfig.of({ get: Effect.succeed(file), setDefaultAgent: () => Effect.void }));

export interface RunOptions extends Runtime.AgentRuntimeOptions {
  /** Env overrides on top of process.env, e.g. idle timeouts. */
  readonly envOverrides?: Record<string, string>;
  /** Extra services for the runtime and the program, e.g. a capturing logger. */
  readonly provide?: Layer.Layer<never>;
}

/** Runs `program` with an AgentRuntime for `file`; the runtime (and every agent process) is gone afterwards. */
export const run = <A, E>(
  file: ConfigFile,
  program: Effect.Effect<A, E, AgentRuntime>,
  options: RunOptions = {},
): Promise<A> => {
  const { envOverrides, provide, ...rest } = options;
  const runtime = Runtime.layerWith({ ...rest, env: { ...process.env, ...envOverrides } }).pipe(
    Layer.provide(Layer.mergeAll(configLayer(file), NodeServices.layer)),
  );
  return Effect.runPromise(program.pipe(Effect.provide(runtime), Effect.scoped, Effect.provide(provide ?? Layer.empty)));
};

export const request = (overrides: Partial<AgentSessionRequest> & { readonly agentId: string }): AgentSessionRequest => ({
  threadId: 'thread-1',
  cwd: process.cwd(),
  additionalDirectories: [],
  nativeSessionId: null,
  ...overrides,
});

export const collect = (stream: Stream.Stream<AgentUpdate>): Effect.Effect<AgentUpdate[]> =>
  Stream.runCollect(stream).pipe(Effect.map((chunk) => [...chunk]));

export const textOf = (updates: readonly AgentUpdate[], kind: 'text' | 'thought' = 'text'): string =>
  updates.flatMap((update) => update.type === 'chunk' && update.kind === kind ? [update.text] : []).join('');

export const endOf = (updates: readonly AgentUpdate[]) => {
  const ends = updates.filter((update) => update.type === 'end');
  if (ends.length !== 1 || updates.at(-1)?.type !== 'end') {
    throw new Error(`expected exactly one final end, got ${JSON.stringify(updates)}`);
  }
  return ends[0] as Extract<AgentUpdate, { type: 'end' }>;
};

/** Whether a pid is still running (signal 0 only checks). */
export const isRunning = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
