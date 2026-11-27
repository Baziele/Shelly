import { homedir } from 'node:os';
import * as Context from 'effect/Context';
import * as Deferred from 'effect/Deferred';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as Layer from 'effect/Layer';
import * as Scope from 'effect/Scope';
import * as Stream from 'effect/Stream';
import { ChildProcess, ChildProcessSpawner } from 'effect/process';
import * as AcpClient from '../../acp/client.js';
import type * as Acp from '../../acp/compat.js';
import type * as AcpError from '../../acp/errors.js';
import { AgentFailed, AgentUnavailable } from '../../protocol/errors.js';
import { type AgentDefinition, agentEnvironment } from './definitions.js';

/*
 * One running ACP agent process. Its sessions share it; session updates and
 * permission requests are routed to them by session id. The process lives in
 * its own scope: closing the scope kills its process group.
 */

export const SHELLY_CLIENT_INFO = { name: 'shelly', version: '0.1.0' } as const;

/** Keep this much of the agent's stderr, for logs when it dies. */
const STDERR_TAIL_CHARS = 8 * 1024;
const INITIALIZE_TIMEOUT = '60 seconds';
/** After SIGTERM, how long an agent's process group gets before SIGKILL. */
export const FORCE_KILL_AFTER = '3 seconds';

/** What a session registers with its process to receive its traffic. */
export interface SessionSink {
  /** Runs on the connection's reader fiber: must not block. */
  readonly onUpdate: (update: Acp.SessionUpdate) => Effect.Effect<void>;
  readonly onPermission: (request: Acp.RequestPermissionRequest) => Effect.Effect<Acp.RequestPermissionResponse>;
}

export interface AgentProcess {
  readonly definition: AgentDefinition;
  readonly pid: number;
  readonly acp: AcpClient.AcpClient['Service'];
  readonly initialize: Acp.InitializeResponse;
  readonly scope: Scope.Closeable;
  /** Sessions open on this process, by the agent's session id. */
  readonly sessions: Map<string, SessionSink>;
  /** Completes with the termination error when the connection ends. */
  readonly terminated: Deferred.Deferred<AcpError.AcpError>;
  readonly stderrTail: () => string;
  /** The agent last reported it isn't signed in (claude-agent-acp's auth/status_update). */
  readonly signedOut: () => boolean;
  readonly isAlive: () => boolean;
}

export interface SpawnHooks {
  /** Called once when the connection ends for any reason other than closing the scope. */
  readonly onTerminated: (process: AgentProcess, error: AcpError.AcpError) => Effect.Effect<void>;
  /** Test hook: the pid of each process spawned. */
  readonly onSpawn?: ((info: { readonly agentId: string; readonly pid: number }) => void) | undefined;
}

const CANCELLED: Acp.RequestPermissionResponse = { outcome: { outcome: 'cancelled' } };

const authState = (params: unknown): string | undefined =>
  typeof params === 'object' && params !== null && typeof (params as { state?: unknown }).state === 'string'
    ? (params as { state: string }).state
    : undefined;

/** Starts the agent's ACP server and initializes it. The process belongs to a new child of `parent`. */
export const spawnAgentProcess = Effect.fn('AgentProcess.spawn')(function* (
  definition: AgentDefinition,
  parent: Scope.Scope,
  hooks: SpawnHooks,
) {
  yield* Effect.annotateCurrentSpan({ agentId: definition.id });
  const launch = definition.launch;
  if (!launch.ok) {
    return yield* new AgentUnavailable({ agentId: definition.id, reason: launch.reason });
  }
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const scope = yield* Scope.fork(parent);
  const fail = (reason: string) =>
    Scope.close(scope, Exit.void).pipe(Effect.andThen(new AgentFailed({ agentId: definition.id, reason })));

  return yield* Effect.gen(function* () {
    const child = yield* spawner.spawn(ChildProcess.make(launch.command, [...launch.args], {
      cwd: homedir(),
      env: agentEnvironment(definition),
      extendEnv: false,
      // Its own process group, so closing the scope kills the agent and whatever it started.
      detached: true,
      // claude-agent-acp awaits its own cleanup on SIGTERM; one that hangs gets SIGKILL
      // (the whole group), so stopping an agent always ends.
      forceKillAfter: FORCE_KILL_AFTER,
    })).pipe(
      Scope.provide(scope),
      Effect.catch(() => fail(`${definition.name} couldn't be started.`)),
    );
    hooks.onSpawn?.({ agentId: definition.id, pid: child.pid });
    yield* Effect.logDebug('agent process started').pipe(Effect.annotateLogs({ agentId: definition.id, pid: child.pid }));

    // effect-acp never reads stderr; an undrained pipe blocks the agent once it fills.
    let stderrTail = '';
    yield* child.stderr.pipe(
      Stream.decodeText(),
      Stream.runForEach((chunk) =>
        Effect.sync(() => {
          stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_CHARS);
        })),
      Effect.ignore,
      Effect.forkIn(scope),
    );

    const sessions = new Map<string, SessionSink>();
    const terminated = yield* Deferred.make<AcpError.AcpError>();
    let alive = true;
    let signedOut = false;
    let process: AgentProcess | undefined;

    const context = yield* Layer.build(AcpClient.layerChildProcess(child, {
      onTermination: (error) =>
        Effect.suspend(() => {
          alive = false;
          return Deferred.succeed(terminated, error).pipe(
            Effect.andThen(process ? hooks.onTerminated(process, error) : Effect.void),
          );
        }),
    })).pipe(Scope.provide(scope));
    const acp = Context.get(context, AcpClient.AcpClient);

    // Every agent→client handler is registered before initialize. Shelly advertises no
    // client fs or terminal, so the only requests agents send are permission requests.
    yield* acp.handleSessionUpdate((notification) =>
      Effect.suspend(() => sessions.get(notification.sessionId)?.onUpdate(notification.update) ?? Effect.void));
    yield* acp.handleRequestPermission((request) =>
      Effect.suspend(() => sessions.get(request.sessionId)?.onPermission(request) ?? Effect.succeed(CANCELLED)));
    yield* acp.handleUnknownExtNotification((method, params) =>
      Effect.sync(() => {
        if (method === 'auth/status_update' || method === '_auth/status_update') {
          const state = authState(params);
          if (state !== undefined) {
            signedOut = state === 'unauthenticated';
          }
        }
      }));

    const initialize = yield* acp.agent.initialize({
      // v1 is what both built-in agents are measured and recorded on; v2 is still a draft.
      protocolVersion: 1,
      clientInfo: SHELLY_CLIENT_INFO,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    }).pipe(
      Effect.timeoutOrElse({
        duration: INITIALIZE_TIMEOUT,
        orElse: () => fail(`${definition.name} didn't respond when Shelly started it.`),
      }),
      Effect.catchTags({
        AcpProcessExitedError: () => fail(`${definition.name} stopped while starting.`),
        AcpInputStreamEndedError: () => fail(`${definition.name} stopped while starting.`),
        AcpRequestError: () => fail(`${definition.name} refused to start a connection.`),
        AcpProtocolParseError: () => fail(`${definition.name} sent something Shelly couldn't read.`),
        AcpTransportError: () => fail(`${definition.name} couldn't be reached.`),
        AcpSpawnError: () => fail(`${definition.name} couldn't be started.`),
      }),
      Effect.tapError(() =>
        Effect.logDebug('agent failed to initialize').pipe(
          Effect.annotateLogs({ agentId: definition.id, stderrTail }),
        )),
    );

    const created: AgentProcess = {
      definition,
      pid: child.pid,
      acp,
      initialize,
      scope,
      sessions,
      terminated,
      stderrTail: () => stderrTail,
      signedOut: () => signedOut,
      isAlive: () => alive,
    };
    process = created;
    if (!created.isAlive()) {
      // It died between initialize and now; report it like any other death.
      const error = yield* Deferred.await(terminated);
      yield* hooks.onTerminated(created, error);
    }
    return created;
  }).pipe(Effect.onInterrupt(() => Scope.close(scope, Exit.void)));
});

/** Ends the process: closing its scope kills its process group. */
export const shutdownAgentProcess = (process: AgentProcess): Effect.Effect<void> =>
  Scope.close(process.scope, Exit.void);
