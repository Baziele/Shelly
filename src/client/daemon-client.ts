import { randomUUID } from 'node:crypto';
import * as NodeSocket from '@effect/platform-node/NodeSocket';
import * as Cause from 'effect/Cause';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as Layer from 'effect/Layer';
import * as ManagedRuntime from 'effect/ManagedRuntime';
import * as RpcClient from 'effect/rpc/RpcClient';
import type { RpcClientError } from 'effect/rpc/RpcClientError';
import type * as RpcGroup from 'effect/rpc/RpcGroup';
import * as RpcSerialization from 'effect/rpc/RpcSerialization';
import * as Schedule from 'effect/Schedule';
import * as Scope from 'effect/Scope';
import * as Stream from 'effect/Stream';
import { shellyPaths } from '../protocol/paths.js';
import { probeSocket } from '../protocol/probe.js';
import { DaemonRpcs } from '../protocol/rpc.js';
import {
  type AgentInfo,
  type FastEvent,
  type FastInput,
  type ModeState,
  PROTOCOL_VERSION,
  type PromptContext,
  type ThreadEvent,
  type ThreadLocation,
  type ThreadSummary,
} from '../protocol/schema.js';
import { SHELLY_VERSION } from '../version.js';
import { type DaemonStartOptions, ensureDaemonStarted, waitForSocketGone } from './daemon-spawn.js';

/*
 * The client's connection to the daemon, for plain TypeScript callers: a
 * Promise per call and an AsyncIterable per stream. Effect stays inside,
 * behind a ManagedRuntime. Load this module with a dynamic import() once the
 * shell is up, never on the startup path.
 *
 * Connecting is lazy: the first call connects (starting the daemon if
 * nothing answers) and says hello. A daemon older than this client (Shelly
 * was upgraded under it) is asked to make way if it is idle, and a new one
 * started; a busy one is used as it is. If the daemon goes away, streams in
 * flight fail with DaemonDisconnected and the next call connects again.
 * Breaking out of a stream stops listening; it never cancels a turn.
 *
 * Errors: the daemon's typed errors (ThreadNotFound, ThreadBusy, …) are
 * thrown as they are; tell them apart by `_tag`.
 *
 * An open connection keeps Node's event loop alive (the socket and its
 * keep-alive pings): call `dispose()` before the process means to exit.
 */

export { ensureDaemonStarted } from './daemon-spawn.js';
export { DaemonStartFailed } from './daemon-spawn.js';

/** The connection dropped (the daemon stopped or crashed). The next call reconnects. */
export class DaemonDisconnected extends Error {
  readonly _tag = 'DaemonDisconnected';
  constructor() {
    super("Lost the connection to Shelly's background service.");
    this.name = 'DaemonDisconnected';
  }
}

/** Nothing answers on the socket and the client was told not to start a daemon. */
export class DaemonNotRunning extends Error {
  readonly _tag = 'DaemonNotRunning';
  constructor() {
    super("Shelly's background service is not running.");
    this.name = 'DaemonNotRunning';
  }
}

export interface DaemonClientOptions extends DaemonStartOptions {
  /** false: never start a daemon; calls fail with DaemonNotRunning instead. */
  readonly autoStart?: boolean | undefined;
  /** Defaults to a random id for this process. */
  readonly clientId?: string | undefined;
  /** For tests: the Shelly version this client reports and compares with the daemon's (SHELLY_VERSION). */
  readonly version?: string | undefined;
}

export interface HelloResult {
  readonly protocolVersion: number;
  readonly daemonVersion: string;
  readonly pid: number;
}

export interface DaemonStatusResult {
  readonly pid: number;
  readonly daemonVersion: string;
  readonly startedAt: number;
  readonly clients: number;
  readonly runningTurns: number;
  readonly agentProcesses: number;
  readonly fastWorkers: number;
}

type Client = RpcClient.RpcClient<RpcGroup.Rpcs<typeof DaemonRpcs>, RpcClientError>;

interface Connection {
  client: Client;
  readonly scope: Scope.Closeable;
  open: boolean;
  hello: HelloResult;
}

const isRpcClientError = (error: unknown): error is RpcClientError =>
  typeof error === 'object' && error !== null && (error as { _tag?: unknown })._tag === 'RpcClientError';

const isProtocolMismatch = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && (error as { _tag?: unknown })._tag === 'ProtocolMismatch';

/** A new daemon after a protocol change: how long the old one gets to exit. */
const OLD_DAEMON_EXIT_TIMEOUT_MS = 3000;

const parseVersion = (version: string): { readonly parts: number[]; readonly pre: string } | undefined => {
  const match = /^(\d+(?:\.\d+)*)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec(version.trim());
  return match ? { parts: match[1]!.split('.').map(Number), pre: match[2] ?? '' } : undefined;
};

/**
 * Negative when `a` is older than `b`, positive when newer, 0 when equal or
 * either cannot be read. A pre-release comes before its release.
 */
export const compareVersions = (a: string, b: string): number => {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) {
    return 0;
  }
  for (let index = 0; index < Math.max(left.parts.length, right.parts.length); index++) {
    const difference = (left.parts[index] ?? 0) - (right.parts[index] ?? 0);
    if (difference !== 0) {
      return Math.sign(difference);
    }
  }
  if (left.pre === right.pre) {
    return 0;
  }
  return left.pre === '' ? 1 : right.pre === '' ? -1 : left.pre < right.pre ? -1 : 1;
};

export class DaemonClient {
  readonly clientId: string;
  private readonly version: string;
  private readonly options: DaemonClientOptions;
  private readonly socketPath: string;
  private readonly runtime = ManagedRuntime.make(Layer.empty);
  private connection: Promise<Connection> | undefined;
  private current: Connection | undefined;

  constructor(options: DaemonClientOptions = {}) {
    this.options = options;
    this.clientId = options.clientId ?? randomUUID();
    this.version = options.version ?? SHELLY_VERSION;
    this.socketPath = shellyPaths(options.env ?? process.env).socket;
  }

  // ─── Connection ───────────────────────────────────────────────────────────

  /** Connect (starting the daemon if needed) and say hello. Later calls reuse the connection. */
  async connect(): Promise<HelloResult> {
    return (await this.ensureConnection()).hello;
  }

  /** Close the connection. The client can connect again later. */
  async close(): Promise<void> {
    const pending = this.connection;
    this.connection = undefined;
    this.current = undefined;
    const connection = await pending?.catch(() => undefined);
    if (connection) {
      await this.closeConnection(connection);
    }
  }

  /** Close the connection and the runtime behind it; the client cannot be used again. */
  async dispose(): Promise<void> {
    await this.close();
    await this.runtime.dispose();
  }

  /** Resolves once nothing answers on the daemon's socket. */
  async waitUntilStopped(timeoutMs = OLD_DAEMON_EXIT_TIMEOUT_MS): Promise<boolean> {
    return waitForSocketGone(this.socketPath, timeoutMs);
  }

  private ensureConnection(): Promise<Connection> {
    if (this.connection && this.current?.open !== false) {
      return this.connection;
    }
    const attempt = this.openConnection().then(
      (connection) => {
        this.current = connection;
        return connection;
      },
      (error: unknown) => {
        if (this.connection === attempt) {
          this.connection = undefined;
        }
        throw error;
      },
    );
    this.connection = attempt;
    return attempt;
  }

  private async startOrFind(): Promise<void> {
    if (this.options.autoStart === false) {
      if (!(await probeSocket(this.socketPath))) {
        throw new DaemonNotRunning();
      }
      return;
    }
    await ensureDaemonStarted(this.options);
  }

  private async openConnection(): Promise<Connection> {
    await this.startOrFind();
    const connection = await this.openSocket();
    try {
      connection.hello = await this.hello(connection);
    } catch (error) {
      if (!isProtocolMismatch(error) || this.options.autoStart === false) {
        await this.closeConnection(connection);
        throw error;
      }
      // An older (or newer) daemon that speaks another protocol: ask it to make way, unless it is busy.
      const fresh = await this.replaceDaemon(connection);
      if (!fresh) {
        await this.closeConnection(connection);
        throw error;
      }
      return fresh;
    }
    if (this.options.autoStart !== false && compareVersions(connection.hello.daemonVersion, this.version) < 0) {
      // Shelly was upgraded while this daemon ran. Same protocol, so a busy
      // one can go on serving; an idle one makes way for the new version.
      // Only ever an older daemon: two versions in use at once must not keep
      // replacing each other's.
      return (await this.replaceDaemon(connection)) ?? connection;
    }
    return connection;
  }

  /**
   * Ask the daemon behind `connection` to stop if it is idle, then start a
   * new one and connect to it. Undefined, with `connection` left open, when
   * it will not stop.
   */
  private async replaceDaemon(connection: Connection): Promise<Connection | undefined> {
    const willStop = await this.run(connection, connection.client['daemon.shutdown']({ ifIdle: true })).catch(() => false);
    if (!willStop) {
      return undefined;
    }
    await this.closeConnection(connection);
    await waitForSocketGone(this.socketPath, OLD_DAEMON_EXIT_TIMEOUT_MS);
    await this.startOrFind();
    const fresh = await this.openSocket();
    try {
      fresh.hello = await this.hello(fresh);
      return fresh;
    } catch (error) {
      await this.closeConnection(fresh);
      throw error;
    }
  }

  private hello(connection: Connection): Promise<HelloResult> {
    return this.run(
      connection,
      connection.client.hello({
        protocolVersion: PROTOCOL_VERSION,
        clientVersion: this.version,
        clientId: this.clientId,
        pid: process.pid,
      }),
    );
  }

  private async openSocket(): Promise<Connection> {
    const scope = await this.runtime.runPromise(Scope.make());
    const connection: Connection = {
      client: undefined as unknown as Client,
      scope,
      open: true,
      hello: { protocolVersion: 0, daemonVersion: '', pid: 0 },
    };
    const hooks = Layer.succeed(RpcClient.ConnectionHooks, {
      onConnect: Effect.void,
      onDisconnect: Effect.sync(() => this.markClosed(connection)),
    });
    const protocol = RpcClient.layerProtocolSocket({
      // A lost daemon is not retried here: the next call reconnects, starting a new one if needed.
      retryPolicy: Schedule.recurs(0),
    }).pipe(
      Layer.provide(NodeSocket.layerNet({ path: this.socketPath })),
      Layer.provide(RpcSerialization.layerNdjson),
      Layer.provide(hooks),
    );
    try {
      const client = await this.runtime.runPromise(
        Effect.gen(function* () {
          const context = yield* Layer.buildWithScope(protocol, scope);
          return yield* RpcClient.make(DaemonRpcs).pipe(Effect.provideContext(context), Scope.provide(scope));
        }),
      );
      connection.client = client;
      return connection;
    } catch (error) {
      await this.runtime.runPromise(Scope.close(scope, Exit.void));
      throw error;
    }
  }

  private markClosed(connection: Connection): void {
    connection.open = false;
    if (this.current === connection) {
      this.current = undefined;
      this.connection = undefined;
    }
  }

  private async closeConnection(connection: Connection): Promise<void> {
    this.markClosed(connection);
    await this.runtime.runPromise(Scope.close(connection.scope, Exit.void)).catch(() => undefined);
  }

  // ─── Calls ────────────────────────────────────────────────────────────────

  private mapError(connection: Connection, error: unknown): unknown {
    if (isRpcClientError(error)) {
      this.markClosed(connection);
      return new DaemonDisconnected();
    }
    return error;
  }

  /** The daemon interrupts calls in flight when it stops: to the caller, that is a lost daemon. */
  private disconnectedOnInterrupt(connection: Connection, cause: Cause.Cause<unknown>): Cause.Cause<unknown> {
    if (Cause.hasInterruptsOnly(cause)) {
      this.markClosed(connection);
      return Cause.fail(new DaemonDisconnected());
    }
    return cause;
  }

  private run<A, E>(connection: Connection, effect: Effect.Effect<A, E>): Promise<A> {
    return this.runtime.runPromise(
      effect.pipe(
        Effect.mapError((error) => this.mapError(connection, error)),
        Effect.catchCause((cause) => Effect.failCause(this.disconnectedOnInterrupt(connection, cause))),
      ),
    );
  }

  private async call<A, E>(make: (client: Client) => Effect.Effect<A, E>): Promise<A> {
    const connection = await this.ensureConnection();
    return this.run(connection, make(connection.client));
  }

  private stream<A, E>(make: (client: Client) => Stream.Stream<A, E>): AsyncIterable<A> {
    const self = this;
    return {
      async *[Symbol.asyncIterator]() {
        const connection = await self.ensureConnection();
        const stream = make(connection.client).pipe(
          Stream.mapError((error) => self.mapError(connection, error)),
          Stream.catchCause((cause) => Stream.failCause(self.disconnectedOnInterrupt(connection, cause))),
        );
        yield* Stream.toAsyncIterable(stream);
      },
    };
  }

  // ─── Agents ───────────────────────────────────────────────────────────────

  listAgents(): Promise<readonly AgentInfo[]> {
    return this.call((client) => client['agents.list']());
  }

  setDefaultAgent(agentId: string): Promise<void> {
    return this.call((client) => client['agents.setDefault']({ agentId }));
  }

  // ─── Threads ──────────────────────────────────────────────────────────────

  createThread(input: { readonly agentId?: string; readonly location: ThreadLocation; readonly cwd: string }): Promise<ThreadSummary> {
    return this.call((client) => client['thread.create'](input));
  }

  listThreads(limit?: number): Promise<readonly ThreadSummary[]> {
    return this.call((client) => client['thread.list'](limit === undefined ? {} : { limit }));
  }

  attachThread(
    threadId: string,
    options: { readonly force?: boolean; readonly historyTurns?: number } = {},
  ): Promise<{ readonly thread: ThreadSummary; readonly history: readonly ThreadEvent[] }> {
    return this.call((client) =>
      client['thread.attach']({
        threadId,
        clientId: this.clientId,
        force: options.force ?? false,
        historyTurns: options.historyTurns ?? 1,
      })
    );
  }

  detachThread(threadId: string): Promise<void> {
    return this.call((client) => client['thread.detach']({ threadId, clientId: this.clientId }));
  }

  /** Start a turn; yields its events from `turn.started` to `turn.ended`. */
  prompt(threadId: string, text: string, context: PromptContext): AsyncIterable<ThreadEvent> {
    return this.stream((client) => client['thread.prompt']({ threadId, clientId: this.clientId, text, context }));
  }

  /** Stored events after `afterSeq`, then live ones until the running turn ends. */
  watch(threadId: string, afterSeq = 0): AsyncIterable<ThreadEvent> {
    return this.stream((client) => client['thread.watch']({ threadId, afterSeq }));
  }

  cancel(threadId: string): Promise<void> {
    return this.call((client) => client['thread.cancel']({ threadId, clientId: this.clientId }));
  }

  respond(threadId: string, requestId: string, optionId: string | null): Promise<void> {
    return this.call((client) => client['thread.respond']({ threadId, clientId: this.clientId, requestId, optionId }));
  }

  setMode(threadId: string, modeId: string): Promise<void> {
    return this.call((client) => client['thread.setMode']({ threadId, clientId: this.clientId, modeId }));
  }

  /** The thread's modes (opening the agent's session if need be); null for an agent without modes. */
  threadModes(threadId: string): Promise<ModeState | null> {
    return this.call((client) => client['thread.modes']({ threadId, clientId: this.clientId }));
  }

  rename(threadId: string, title: string): Promise<void> {
    return this.call((client) => client['thread.rename']({ threadId, clientId: this.clientId, title }));
  }

  deleteThread(threadId: string): Promise<void> {
    return this.call((client) => client['thread.delete']({ threadId, clientId: this.clientId }));
  }

  /** `cwd`: the shell's directory now, as the coming prompt's context will give it. */
  prewarmThread(input: { readonly threadId?: string; readonly agentId?: string; readonly cwd?: string } = {}): Promise<void> {
    return this.call((client) => client['thread.prewarm'](input));
  }

  // ─── Fast mode ────────────────────────────────────────────────────────────

  prewarmFast(agentId?: string): Promise<void> {
    return this.call((client) => client['fast.prewarm'](agentId === undefined ? {} : { agentId }));
  }

  fastRequest(input: { readonly agentId?: string; readonly sessionKey: string; readonly input: FastInput }): AsyncIterable<FastEvent> {
    return this.stream((client) => client['fast.request'](input));
  }

  endFast(sessionKey: string): Promise<void> {
    return this.call((client) => client['fast.end']({ sessionKey }));
  }

  // ─── The daemon ───────────────────────────────────────────────────────────

  status(): Promise<DaemonStatusResult> {
    return this.call((client) => client['daemon.status']());
  }

  /** Ask the daemon to exit; with `ifIdle`, only when no turn runs and no client has a stream open. Resolves with whether it will. */
  shutdown(ifIdle: boolean): Promise<boolean> {
    return this.call((client) => client['daemon.shutdown']({ ifIdle }));
  }
}
