import { connect, type Socket } from 'node:net';
import type * as Rpc from 'effect/rpc/Rpc';
import type * as RpcGroup from 'effect/rpc/RpcGroup';
import { ERROR_MESSAGES, isDaemonErrorTag } from '../protocol/error-messages.js';
import type { DaemonRpcs } from '../protocol/rpc.js';

/*
 * The client's side of the daemon's socket, by hand: Effect RPC's wire
 * format (NDJSON) without Effect, which costs a terminal's client about
 * 40 MB and 130 ms to connect. The daemon serves the same messages with
 * Effect's RpcServer (src/daemon/server.ts); test/e2e/daemon-contract.e2e.ts
 * holds the two together, call by call.
 *
 * The messages, one JSON object per line:
 * - to the daemon: Request {id, tag, payload, headers}, Ack {requestId}
 *   (after each Chunk: the server sends a stream's next chunk only once the
 *   last is acknowledged), Interrupt {requestId} (stop a call or stream),
 *   Ping, Pong;
 * - from it: Chunk {requestId, values} (a stream's values), Exit
 *   {requestId, exit} (a call's result, or a stream's end), Defect (the
 *   connection is broken), Pong, Ping.
 *
 * An exit is {_tag: 'Success', value} or {_tag: 'Failure', cause}, the cause
 * a list of {_tag: 'Fail', error} (a typed error, as its schema encodes it:
 * `_tag` and fields), {_tag: 'Die', defect} and {_tag: 'Interrupt'}.
 *
 * Nothing here checks values against the schemas: the daemon is ours, and
 * says hello with the protocol version first (see DaemonClient). Streams
 * take a guard for the values a caller relies on.
 */

/** Every call the daemon serves, and whether it streams. Must name every RPC in DaemonRpcs (a test checks). */
export const DAEMON_RPCS = {
  hello: 'call',
  'agents.list': 'call',
  'agents.setDefault': 'call',
  'thread.create': 'call',
  'thread.list': 'call',
  'thread.attach': 'call',
  'thread.detach': 'call',
  'thread.prompt': 'stream',
  'thread.watch': 'stream',
  'thread.cancel': 'call',
  'thread.respond': 'call',
  'thread.setMode': 'call',
  'thread.modes': 'call',
  'thread.rename': 'call',
  'thread.delete': 'call',
  'thread.prewarm': 'call',
  'fast.prewarm': 'call',
  'fast.request': 'stream',
  'fast.end': 'call',
  'daemon.status': 'call',
  'daemon.shutdown': 'call',
} as const satisfies Record<Rpc.Tag<RpcGroup.Rpcs<typeof DaemonRpcs>>, 'call' | 'stream'>;

export type DaemonRpcTag = keyof typeof DAEMON_RPCS;
export type CallTag = { [K in DaemonRpcTag]: (typeof DAEMON_RPCS)[K] extends 'call' ? K : never }[DaemonRpcTag];
export type StreamTag = { [K in DaemonRpcTag]: (typeof DAEMON_RPCS)[K] extends 'stream' ? K : never }[DaemonRpcTag];

/** How often to ping the daemon, and how long without a word from it means it is gone (as Effect's client). */
const PING_INTERVAL_MS = 5000;
const PING_TIMEOUT_MS = 10_000;
/** A stream's values a slow reader may have waiting before the daemon is asked for more. */
const STREAM_BUFFER = 64;

/** The connection dropped (the daemon stopped or crashed). The next call reconnects. */
export class DaemonDisconnected extends Error {
  readonly _tag = 'DaemonDisconnected';
  constructor() {
    super("Lost the connection to Shelly's background service.");
    this.name = 'DaemonDisconnected';
  }
}

/**
 * A typed error from the daemon (ThreadNotFound, ThreadBusy, …), with its
 * fields, and the message the daemon's own error class would give.
 */
export class DaemonError extends Error {
  readonly _tag: string;
  [field: string]: unknown;

  constructor(error: Readonly<Record<string, unknown>>) {
    const tag = typeof error._tag === 'string' ? error._tag : 'UnknownError';
    super(
      isDaemonErrorTag(tag)
        ? ERROR_MESSAGES[tag](error as never)
        : typeof error.message === 'string' ? error.message : `Shelly's background service failed (${tag}).`,
    );
    Object.assign(this, error);
    this._tag = tag;
    this.name = tag;
  }
}

/** Whether a stream's value goes to the reader, is skipped (a kind this client does not know), or breaks the stream. */
export type Guard = (value: unknown) => 'yield' | 'skip' | 'reject';

type Message = Readonly<Record<string, unknown>> & { readonly _tag?: unknown };

interface Pending {
  readonly onChunk: (values: readonly unknown[]) => void;
  readonly onExit: (exit: unknown) => void;
  readonly onError: (error: Error) => void;
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const defectMessage = (defect: unknown): string => {
  if (typeof defect === 'string') {
    return defect;
  }
  if (isRecord(defect) && typeof defect.message === 'string') {
    return defect.message;
  }
  return JSON.stringify(defect) ?? 'unknown defect';
};

/** The error an exit's cause comes to: its typed failure, else a lost daemon (interrupted only), else the defect. */
export const errorOfCause = (cause: unknown): Error => {
  const parts = Array.isArray(cause) ? cause.filter(isRecord) : [];
  const fail = parts.find((part) => part._tag === 'Fail');
  if (fail) {
    return isRecord(fail.error) ? new DaemonError(fail.error) : new Error(defectMessage(fail.error));
  }
  if (parts.length > 0 && parts.every((part) => part._tag === 'Interrupt')) {
    // The daemon interrupts what is in flight when it stops: to the caller, that is a lost daemon.
    return new DaemonDisconnected();
  }
  const die = parts.find((part) => part._tag === 'Die');
  return new Error(`Shelly's background service failed: ${die ? defectMessage(die.defect) : 'no reason given'}`);
};

/** The value of a successful exit; throws the failure otherwise. */
const valueOfExit = (exit: unknown): unknown => {
  if (isRecord(exit) && exit._tag === 'Success') {
    return exit.value;
  }
  throw errorOfCause(isRecord(exit) ? exit.cause : undefined);
};

/** One connection to the daemon's socket. Closed for good once the socket closes. */
export class RpcConnection {
  private readonly pending = new Map<string, Pending>();
  private readonly pongs: { readonly resolve: () => void; readonly reject: (error: Error) => void }[] = [];
  private nextId = 0;
  private buffer = '';
  private lastHeard = Date.now();
  private awaitingPong = false;
  private readonly pinger: NodeJS.Timeout;
  private closed = false;

  private constructor(
    private readonly socket: Socket,
    private readonly onClose: () => void,
  ) {
    socket.setEncoding('utf8');
    socket.on('data', (data: string) => this.receive(data));
    socket.on('error', () => undefined);
    socket.on('close', () => this.shut(new DaemonDisconnected()));
    this.pinger = setInterval(() => this.keepAlive(), PING_INTERVAL_MS);
    this.pinger.unref();
  }

  /** Connect to the socket at `path`. `onClose` runs once, when the connection closes for any reason. */
  static open(path: string, onClose: () => void = () => undefined): Promise<RpcConnection> {
    return new Promise((resolve, reject) => {
      const socket = connect({ path });
      socket.once('error', reject);
      socket.once('connect', () => {
        socket.off('error', reject);
        resolve(new RpcConnection(socket, onClose));
      });
    });
  }

  get isOpen(): boolean {
    return !this.closed;
  }

  /** One call: resolves with its value, rejects with its error (DaemonError, DaemonDisconnected, …). */
  call(tag: CallTag, payload: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = this.request(tag, payload, {
        onChunk: () => undefined,
        onExit: (exit) => {
          try {
            resolve(valueOfExit(exit));
          } catch (error) {
            reject(error);
          }
        },
        onError: reject,
      });
      if (id === undefined) {
        reject(new DaemonDisconnected());
      }
    });
  }

  /**
   * A stream's values, as they come. The request goes out on the first
   * `next()`. Stopping early (break, `return()`, even while a `next()` is
   * waiting) interrupts it at once: the daemon stops sending (a turn goes
   * on running; see `thread.cancel`).
   */
  stream<A>(tag: StreamTag, payload: unknown, guard: Guard): AsyncIterable<A> {
    return { [Symbol.asyncIterator]: () => this.openStream<A>(tag, payload, guard) };
  }

  private openStream<A>(tag: StreamTag, payload: unknown, guard: Guard): AsyncIterator<A, undefined> {
    const done: IteratorReturnResult<undefined> = { done: true, value: undefined };
    const queue: unknown[] = [];
    const readers: { readonly resolve: (result: IteratorResult<A, undefined>) => void; readonly reject: (error: unknown) => void }[] = [];
    let id: string | undefined;
    let ackOwed = false;
    /** The daemon ended the stream (or the connection did), with `failure` if it failed. */
    let ended = false;
    let failure: Error | undefined;
    /** Nothing more for the reader: the end was read, or the reader stopped. */
    let finished = false;

    const stop = (): void => {
      if (!ended && !finished && id !== undefined) {
        this.pending.delete(id);
        this.send({ _tag: 'Interrupt', requestId: id });
      }
      finished = true;
      queue.length = 0;
    };
    /** The next result for a reader, or undefined to wait for more. Throws what the stream failed with. */
    const take = (): IteratorResult<A, undefined> | undefined => {
      while (queue.length > 0) {
        const value = queue.shift();
        if (ackOwed && queue.length <= STREAM_BUFFER / 2) {
          ackOwed = false;
          this.send({ _tag: 'Ack', requestId: id });
        }
        const verdict = guard(value);
        if (verdict === 'reject') {
          stop();
          throw new Error(`Shelly's background service sent something this terminal does not understand (${tag}).`);
        }
        if (verdict === 'yield') {
          return { done: false, value: value as A };
        }
      }
      if (finished) {
        return done;
      }
      if (ended) {
        finished = true;
        if (failure) {
          throw failure;
        }
        return done;
      }
      return undefined;
    };
    /** Serve waiting readers, in order, as far as there is something for them. */
    const serve = (): void => {
      while (readers.length > 0) {
        let result: IteratorResult<A, undefined> | undefined;
        try {
          result = take();
        } catch (error) {
          readers.shift()!.reject(error);
          continue;
        }
        if (!result) {
          return;
        }
        readers.shift()!.resolve(result);
      }
    };
    const start = (): void => {
      id = this.request(tag, payload, {
        onChunk: (values) => {
          queue.push(...values);
          if (queue.length <= STREAM_BUFFER) {
            this.send({ _tag: 'Ack', requestId: id });
          } else {
            ackOwed = true;
          }
          serve();
        },
        onExit: (exit) => {
          ended = true;
          try {
            valueOfExit(exit);
          } catch (error) {
            failure = error as Error;
          }
          serve();
        },
        onError: (error) => {
          ended = true;
          failure = error;
          serve();
        },
      });
      if (id === undefined) {
        ended = true;
        failure = new DaemonDisconnected();
      }
    };

    return {
      next: () => {
        if (id === undefined && !ended && !finished) {
          start();
        }
        return new Promise((resolve, reject) => {
          readers.push({ resolve, reject });
          serve();
        });
      },
      return: () => {
        stop();
        readers.splice(0).forEach((reader) => reader.resolve(done));
        return Promise.resolve(done);
      },
    };
  }

  /** Resolves once the daemon answers a ping. */
  ping(): Promise<void> {
    if (this.closed) {
      return Promise.reject(new DaemonDisconnected());
    }
    return new Promise((resolve, reject) => {
      this.pongs.push({ resolve, reject });
      this.send({ _tag: 'Ping' });
    });
  }

  close(): void {
    this.socket.end();
    this.socket.destroy();
    this.shut(new DaemonDisconnected());
  }

  private request(tag: DaemonRpcTag, payload: unknown, pending: Pending): string | undefined {
    if (this.closed) {
      return undefined;
    }
    const id = String(++this.nextId);
    this.pending.set(id, pending);
    // A call without a payload sends null: the daemon decodes it as its schema's void.
    this.send({ _tag: 'Request', id, tag, payload: payload === undefined ? null : payload, headers: [] });
    return id;
  }

  private send(message: Message): void {
    if (!this.closed) {
      this.socket.write(`${JSON.stringify(message)}\n`);
    }
  }

  private receive(data: string): void {
    this.lastHeard = Date.now();
    this.awaitingPong = false;
    this.buffer += data;
    let newline = this.buffer.indexOf('\n');
    while (newline !== -1 && !this.closed) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) {
        let message: unknown;
        try {
          message = JSON.parse(line);
        } catch {
          this.fail(new Error("Shelly's background service sent something that is not JSON."));
          return;
        }
        this.handle(message);
      }
      newline = this.buffer.indexOf('\n');
    }
  }

  private handle(message: unknown): void {
    if (!isRecord(message)) {
      return;
    }
    switch (message._tag) {
      case 'Chunk': {
        const pending = this.pending.get(String(message.requestId));
        if (pending && Array.isArray(message.values)) {
          pending.onChunk(message.values);
        }
        return;
      }
      case 'Exit': {
        const id = String(message.requestId);
        const pending = this.pending.get(id);
        if (pending) {
          this.pending.delete(id);
          pending.onExit(message.exit);
        }
        return;
      }
      case 'Pong':
        this.pongs.splice(0).forEach((pong) => pong.resolve());
        return;
      case 'Ping':
        this.send({ _tag: 'Pong' });
        return;
      case 'Defect':
        // The daemon could not make sense of this connection: everything on it fails.
        this.fail(new Error(`Shelly's background service failed: ${defectMessage(message.defect)}`));
        return;
      default:
        // Anything else (a ClientProtocolError, a request to the client) this client has no use for.
        return;
    }
  }

  /** Every 5 s; a daemon that says nothing for 10 s after a ping is taken for gone. */
  private keepAlive(): void {
    if (this.awaitingPong && Date.now() - this.lastHeard > PING_TIMEOUT_MS) {
      this.fail(new DaemonDisconnected());
      return;
    }
    this.awaitingPong = true;
    this.send({ _tag: 'Ping' });
  }

  private fail(error: Error): void {
    this.socket.destroy();
    this.shut(error);
  }

  private shut(error: Error): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    clearInterval(this.pinger);
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const entry of pending) {
      entry.onError(error);
    }
    this.pongs.splice(0).forEach((pong) => pong.reject(error));
    this.onClose();
  }
}
