import { randomUUID } from 'node:crypto';
import { checkFastEvent, checkThreadEvent } from '../protocol/guards.js';
import { shellyPaths } from '../protocol/paths.js';
import { probeSocket } from '../protocol/probe.js';
import type {
  AgentInfo,
  FastEvent,
  FastInput,
  ModeState,
  PromptContext,
  ThreadEvent,
  ThreadLocation,
  ThreadSummary,
} from '../protocol/schema.js';
import { PROTOCOL_VERSION } from '../protocol/version.js';
import { SHELLY_VERSION } from '../version.js';
import { type DaemonStartOptions, ensureDaemonStarted, waitForSocketGone } from './daemon-spawn.js';
import { type CallTag, DaemonDisconnected, DaemonError, type Guard, RpcConnection, type StreamTag } from './rpc-connection.js';

/*
 * The client's connection to the daemon, for plain TypeScript callers: a
 * Promise per call and an AsyncIterable per stream, over a hand-written
 * RPC client (rpc-connection.ts) that loads no Effect. Load this module
 * with a dynamic import() when Shelly is about to be used, never on the
 * startup path.
 *
 * Connecting is lazy: the first call connects (starting the daemon if
 * nothing answers) and says hello. A daemon older than this client (Shelly
 * was upgraded under it) is asked to make way if it is idle, and a new one
 * started; a busy one is used as it is. If the daemon goes away, streams in
 * flight fail with DaemonDisconnected and the next call connects again.
 * Breaking out of a stream stops listening; it never cancels a turn.
 *
 * Errors: the daemon's typed errors (ThreadNotFound, ThreadBusy, …) are
 * thrown as DaemonError, with the daemon's `_tag`, fields and message; tell
 * them apart by `_tag`.
 *
 * An open connection keeps Node's event loop alive (the socket and its
 * keep-alive pings): call `dispose()` before the process means to exit.
 */

export { ensureDaemonStarted } from './daemon-spawn.js';
export { DaemonStartFailed } from './daemon-spawn.js';

export { DaemonDisconnected, DaemonError } from './rpc-connection.js';

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

interface Connection {
  readonly rpc: RpcConnection;
  hello: HelloResult;
}

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
  private connection: Promise<Connection> | undefined;
  private current: Connection | undefined;
  private disposed = false;

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
    connection?.rpc.close();
  }

  /** Close the connection for good; the client cannot be used again. */
  async dispose(): Promise<void> {
    this.disposed = true;
    await this.close();
  }

  /** Resolves once nothing answers on the daemon's socket. */
  async waitUntilStopped(timeoutMs = OLD_DAEMON_EXIT_TIMEOUT_MS): Promise<boolean> {
    return waitForSocketGone(this.socketPath, timeoutMs);
  }

  private ensureConnection(): Promise<Connection> {
    if (this.disposed) {
      return Promise.reject(new DaemonDisconnected());
    }
    if (this.connection && this.current?.rpc.isOpen !== false) {
      return this.connection;
    }
    const attempt = this.openConnection().then(
      (connection) => {
        if (this.disposed) {
          connection.rpc.close();
          throw new DaemonDisconnected();
        }
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
        connection.rpc.close();
        throw error;
      }
      // An older (or newer) daemon that speaks another protocol: ask it to make way, unless it is busy.
      const fresh = await this.replaceDaemon(connection);
      if (!fresh) {
        connection.rpc.close();
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
    const willStop = await connection.rpc.call('daemon.shutdown', { ifIdle: true }).catch(() => false);
    if (willStop !== true) {
      return undefined;
    }
    connection.rpc.close();
    await waitForSocketGone(this.socketPath, OLD_DAEMON_EXIT_TIMEOUT_MS);
    await this.startOrFind();
    const fresh = await this.openSocket();
    try {
      fresh.hello = await this.hello(fresh);
      return fresh;
    } catch (error) {
      fresh.rpc.close();
      throw error;
    }
  }

  private async hello(connection: Connection): Promise<HelloResult> {
    const hello = await connection.rpc.call('hello', {
      protocolVersion: PROTOCOL_VERSION,
      clientVersion: this.version,
      clientId: this.clientId,
      pid: process.pid,
    });
    if (!isHello(hello)) {
      throw new Error("Shelly's background service answered hello with something this terminal does not understand.");
    }
    if (hello.protocolVersion !== PROTOCOL_VERSION) {
      // The daemon checks this itself; a daemon that did not is just as foreign.
      throw new DaemonError({ _tag: 'ProtocolMismatch', daemonProtocol: hello.protocolVersion, clientProtocol: PROTOCOL_VERSION });
    }
    return hello;
  }

  private async openSocket(): Promise<Connection> {
    const connection: Connection = {
      rpc: undefined as unknown as RpcConnection,
      hello: { protocolVersion: 0, daemonVersion: '', pid: 0 },
    };
    const rpc = await RpcConnection.open(this.socketPath, () => this.markClosed(connection));
    (connection as { rpc: RpcConnection }).rpc = rpc;
    return connection;
  }

  private markClosed(connection: Connection): void {
    if (this.current === connection) {
      this.current = undefined;
      this.connection = undefined;
    }
  }

  // ─── Calls ────────────────────────────────────────────────────────────────

  /** A daemon that interrupts a call is stopping: this connection is done with, and the next call reconnects. */
  private lost(connection: Connection, error: unknown): unknown {
    if (error instanceof DaemonDisconnected) {
      this.markClosed(connection);
      connection.rpc.close();
    }
    return error;
  }

  private async call<A>(tag: CallTag, payload: unknown): Promise<A> {
    const connection = await this.ensureConnection();
    try {
      return (await connection.rpc.call(tag, payload)) as A;
    } catch (error) {
      throw this.lost(connection, error);
    }
  }

  /** As RpcConnection.stream, connecting first; `return()` stops it at once, even mid-connect. */
  private stream<A>(tag: StreamTag, payload: unknown, guard: Guard): AsyncIterable<A> {
    return {
      [Symbol.asyncIterator]: (): AsyncIterator<A, undefined> => {
        const done: IteratorReturnResult<undefined> = { done: true, value: undefined };
        let opening: Promise<{ readonly connection: Connection; readonly events: AsyncIterator<A, undefined> }> | undefined;
        let stopped = false;
        return {
          next: async () => {
            if (stopped) {
              return done;
            }
            opening ??= this.ensureConnection().then((connection) => ({
              connection,
              events: connection.rpc.stream<A>(tag, payload, guard)[Symbol.asyncIterator]() as AsyncIterator<A, undefined>,
            }));
            const { connection, events } = await opening;
            if (stopped) {
              return done;
            }
            try {
              return await events.next();
            } catch (error) {
              throw this.lost(connection, error);
            }
          },
          return: async () => {
            stopped = true;
            // Not waiting for a connection still being made: a stream it opens is never started.
            void opening?.then(({ events }) => events.return?.(), () => undefined);
            return done;
          },
        };
      },
    };
  }

  // ─── Agents ───────────────────────────────────────────────────────────────

  listAgents(): Promise<readonly AgentInfo[]> {
    return this.call('agents.list', undefined);
  }

  setDefaultAgent(agentId: string): Promise<void> {
    return this.call('agents.setDefault', { agentId });
  }

  // ─── Threads ──────────────────────────────────────────────────────────────

  createThread(input: { readonly agentId?: string; readonly location: ThreadLocation; readonly cwd: string }): Promise<ThreadSummary> {
    return this.call('thread.create', input);
  }

  listThreads(limit?: number): Promise<readonly ThreadSummary[]> {
    return this.call('thread.list', limit === undefined ? {} : { limit });
  }

  async attachThread(
    threadId: string,
    options: { readonly force?: boolean; readonly historyTurns?: number } = {},
  ): Promise<{ readonly thread: ThreadSummary; readonly history: readonly ThreadEvent[] }> {
    const attached = await this.call<{ readonly thread: ThreadSummary; readonly history: readonly unknown[] }>('thread.attach', {
      threadId,
      clientId: this.clientId,
      force: options.force ?? false,
      historyTurns: options.historyTurns ?? 1,
    });
    const history = Array.isArray(attached.history) ? attached.history : [];
    if (history.some((event) => checkThreadEvent(event) === 'reject')) {
      throw new Error("Shelly's background service sent a thread's history this terminal does not understand.");
    }
    return { thread: attached.thread, history: history.filter((event) => checkThreadEvent(event) === 'yield') as ThreadEvent[] };
  }

  detachThread(threadId: string): Promise<void> {
    return this.call('thread.detach', { threadId, clientId: this.clientId });
  }

  /** Start a turn; yields its events from `turn.started` to `turn.ended`. */
  prompt(threadId: string, text: string, context: PromptContext): AsyncIterable<ThreadEvent> {
    return this.stream('thread.prompt', { threadId, clientId: this.clientId, text, context }, checkThreadEvent);
  }

  /** Stored events after `afterSeq`, then live ones until the running turn ends. */
  watch(threadId: string, afterSeq = 0): AsyncIterable<ThreadEvent> {
    return this.stream('thread.watch', { threadId, afterSeq }, checkThreadEvent);
  }

  cancel(threadId: string): Promise<void> {
    return this.call('thread.cancel', { threadId, clientId: this.clientId });
  }

  respond(threadId: string, requestId: string, optionId: string | null): Promise<void> {
    return this.call('thread.respond', { threadId, clientId: this.clientId, requestId, optionId });
  }

  setMode(threadId: string, modeId: string): Promise<void> {
    return this.call('thread.setMode', { threadId, clientId: this.clientId, modeId });
  }

  /** The thread's modes (opening the agent's session if need be); null for an agent without modes. */
  threadModes(threadId: string): Promise<ModeState | null> {
    return this.call('thread.modes', { threadId, clientId: this.clientId });
  }

  rename(threadId: string, title: string): Promise<void> {
    return this.call('thread.rename', { threadId, clientId: this.clientId, title });
  }

  deleteThread(threadId: string): Promise<void> {
    return this.call('thread.delete', { threadId, clientId: this.clientId });
  }

  /** `cwd`: the shell's directory now, as the coming prompt's context will give it. */
  prewarmThread(input: { readonly threadId?: string; readonly agentId?: string; readonly cwd?: string } = {}): Promise<void> {
    return this.call('thread.prewarm', input);
  }

  // ─── Fast mode ────────────────────────────────────────────────────────────

  prewarmFast(agentId?: string): Promise<void> {
    return this.call('fast.prewarm', agentId === undefined ? {} : { agentId });
  }

  fastRequest(input: { readonly agentId?: string; readonly sessionKey: string; readonly input: FastInput }): AsyncIterable<FastEvent> {
    return this.stream('fast.request', input, checkFastEvent);
  }

  endFast(sessionKey: string): Promise<void> {
    return this.call('fast.end', { sessionKey });
  }

  // ─── The daemon ───────────────────────────────────────────────────────────

  status(): Promise<DaemonStatusResult> {
    return this.call('daemon.status', undefined);
  }

  /** Ask the daemon to exit; with `ifIdle`, only when no turn runs and no client has a stream open. Resolves with whether it will. */
  shutdown(ifIdle: boolean): Promise<boolean> {
    return this.call('daemon.shutdown', { ifIdle });
  }
}

const isHello = (value: unknown): value is HelloResult =>
  typeof value === 'object' && value !== null
  && typeof (value as HelloResult).protocolVersion === 'number'
  && typeof (value as HelloResult).daemonVersion === 'string'
  && typeof (value as HelloResult).pid === 'number';
