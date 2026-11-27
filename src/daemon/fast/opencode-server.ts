import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { WorkerFailure } from './worker.js';

/*
 * The connection to OpenCode's background service, which fast mode's
 * OpenCode sessions share.
 *
 * OpenCode 2.x runs one HTTP server per user (`opencode service`); its CLI,
 * TUI and `opencode acp` all talk to it, starting it when it is stopped.
 * Shelly does the same: it finds the service in the state file OpenCode
 * keeps for its clients, starts it with `opencode service start` when it
 * is not running, and never stops it, since it is not Shelly's.
 *
 * One event stream (SSE) carries every session's events; it does not
 * replay, so it is open before any session is made. HTTP Basic auth, user
 * `opencode`, UTF-8. Shelly holds the stream only while it has sessions.
 */

const USERNAME = 'opencode';
const INFO_TIMEOUT_MS = 3000;
const REQUEST_TIMEOUT_MS = 10_000;
export const SUBSCRIBE_TIMEOUT_MS = 5000;
const START_TIMEOUT_MS = 20_000;
/** The service sends a heartbeat every 15 seconds; this much silence means it is gone. */
const SILENCE_MS = 45_000;
/** How long the connection stays open after its last session ends, so sessions that come and go don't reconnect each time. */
export const CONNECTION_GRACE_MS = 30_000;

export interface ConnectionTimings {
  /** How long connecting to the event stream may take. */
  readonly subscribeTimeoutMs: number;
}


export const SERVICE_DIDNT_START = "OpenCode's background service didn't start. Try `opencode service start`.";
export const SERVICE_UNREACHABLE = "Shelly couldn't reach OpenCode's background service. Try `opencode service restart`.";
export const SERVICE_REJECTED = "OpenCode's background service didn't accept Shelly. Try `opencode service restart`.";

/** A failure the caller reports as is. */
export class OpenCodeServiceError extends Error {
  constructor(readonly failure: WorkerFailure) {
    super(failure.reason);
  }
}

/** An HTTP error response from the service. */
export class OpenCodeHttpError extends Error {
  constructor(readonly status: number, readonly body: string) {
    super(`OpenCode answered HTTP ${status}`);
  }
}

export interface ServiceAddress {
  readonly url: string;
  readonly password: string;
}

/** Where OpenCode records its running service: `$XDG_STATE_HOME/opencode/service.json`. */
export const serviceStatePath = (env: NodeJS.ProcessEnv): string =>
  join(env.XDG_STATE_HOME || join(env.HOME || homedir(), '.local', 'state'), 'opencode', 'service.json');

export const readServiceState = (env: NodeJS.ProcessEnv): ServiceAddress | null => {
  try {
    const state = JSON.parse(readFileSync(serviceStatePath(env), 'utf8')) as { url?: unknown; password?: unknown };
    if (typeof state.url !== 'string' || typeof state.password !== 'string') return null;
    return { url: state.url.replace(/\/+$/, ''), password: state.password };
  } catch {
    return null;
  }
};

/** OpenCode wants UTF-8 Basic credentials. */
const authorization = (password: string): string =>
  `Basic ${Buffer.from(`${USERNAME}:${password}`, 'utf8').toString('base64')}`;

const checkInfo = async (address: ServiceAddress): Promise<'ok' | 'rejected' | 'unreachable'> => {
  try {
    const response = await fetch(`${address.url}/api/info`, {
      headers: { authorization: authorization(address.password) },
      signal: AbortSignal.timeout(INFO_TIMEOUT_MS),
    });
    await response.body?.cancel();
    if (response.ok) return 'ok';
    return response.status === 401 || response.status === 403 ? 'rejected' : 'unreachable';
  } catch {
    return 'unreachable';
  }
};

const startService = (executable: string, env: NodeJS.ProcessEnv): Promise<void> =>
  new Promise((resolve) => {
    // It starts the service detached and exits; a failure shows up as no service below.
    execFile(executable, ['service', 'start'], { env, timeout: START_TIMEOUT_MS }, () => resolve());
  });

/** The running service, started first when it is stopped. */
export const discoverService = async (executable: string, env: NodeJS.ProcessEnv): Promise<ServiceAddress> => {
  const known = readServiceState(env);
  if (known && (await checkInfo(known)) === 'ok') return known;
  await startService(executable, env);
  const started = readServiceState(env);
  if (!started) throw new OpenCodeServiceError({ kind: 'failed', reason: SERVICE_DIDNT_START });
  const status = await checkInfo(started);
  if (status === 'ok') return started;
  throw new OpenCodeServiceError({ kind: 'failed', reason: status === 'rejected' ? SERVICE_REJECTED : SERVICE_UNREACHABLE });
};

// ─── The connection ─────────────────────────────────────────────────────────

/** One event from the stream; only the fields read here. */
export interface OpenCodeEvent {
  readonly type: string;
  readonly data?: { readonly sessionID?: string; readonly [key: string]: unknown };
}

/** Sent to every listener when the stream ends without being closed: the service stopped. */
export const CONNECTION_LOST = 'shelly.connection.lost';

export class OpenCodeConnection {
  private readonly listeners = new Map<string, (event: OpenCodeEvent) => void>();
  private readonly abort = new AbortController();
  private silence: NodeJS.Timeout | undefined;
  private ended = false;
  /** Called once when the stream is lost (not when it is closed). */
  onLost: (() => void) | null = null;

  /** When the connection began; sessions made before it are not this daemon's. */
  readonly openedAt = Date.now();

  private constructor(private readonly address: ServiceAddress, private readonly timings: ConnectionTimings) {}

  /** Subscribe to the event stream; resolves once the service has accepted it. */
  static async open(address: ServiceAddress, timings: ConnectionTimings = { subscribeTimeoutMs: SUBSCRIBE_TIMEOUT_MS }): Promise<OpenCodeConnection> {
    const connection = new OpenCodeConnection(address, timings);
    await connection.subscribe();
    return connection;
  }

  get closed(): boolean {
    return this.ended;
  }

  /** Route one session's events to `listener`; returns the unsubscribe. */
  listen(sessionId: string, listener: (event: OpenCodeEvent) => void): () => void {
    this.listeners.set(sessionId, listener);
    return () => {
      if (this.listeners.get(sessionId) === listener) this.listeners.delete(sessionId);
    };
  }

  async request<T = unknown>(method: string, path: string, body?: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
    const response = await fetch(`${this.address.url}${path}`, {
      method,
      headers: {
        authorization: authorization(this.address.password),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(timeoutMs)]),
    });
    const text = await response.text();
    if (!response.ok) throw new OpenCodeHttpError(response.status, text);
    return (text === '' ? undefined : JSON.parse(text)) as T;
  }

  /** Stop the stream. Listeners hear nothing more. */
  close(): void {
    if (this.ended) return;
    this.ended = true;
    clearTimeout(this.silence);
    this.listeners.clear();
    this.abort.abort();
  }

  private async subscribe(): Promise<void> {
    let response: Response;
    // A timer, not AbortSignal.timeout: a fetch's signal stays on its body, and would end the stream itself.
    const connectTimer = setTimeout(() => this.abort.abort(), this.timings.subscribeTimeoutMs);
    try {
      response = await fetch(`${this.address.url}/api/event`, {
        headers: { authorization: authorization(this.address.password), accept: 'text/event-stream' },
        signal: this.abort.signal,
      });
    } catch {
      this.close();
      throw new OpenCodeServiceError({ kind: 'failed', reason: SERVICE_UNREACHABLE });
    } finally {
      clearTimeout(connectTimer);
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      this.close();
      const rejected = response.status === 401 || response.status === 403;
      throw new OpenCodeServiceError({ kind: 'failed', reason: rejected ? SERVICE_REJECTED : SERVICE_UNREACHABLE });
    }
    // From here the stream is watched for silence only.
    const { promise: accepted, resolve: accept } = Promise.withResolvers<void>();
    void this.read(response.body, accept);
    const timer = setTimeout(accept, this.timings.subscribeTimeoutMs);
    await accepted;
    clearTimeout(timer);
    if (this.ended) throw new OpenCodeServiceError({ kind: 'failed', reason: SERVICE_UNREACHABLE });
  }

  private async read(body: ReadableStream<Uint8Array>, accept: () => void): Promise<void> {
    const decoder = new TextDecoder();
    let buffer = '';
    this.armSilence();
    try {
      for await (const chunk of body) {
        this.armSilence();
        buffer += decoder.decode(chunk, { stream: true }).replaceAll('\r', '');
        let end: number;
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const event = parseFrame(frame);
          if (!event) continue;
          if (event.type === 'server.connected') accept();
          const sessionId = event.data?.sessionID;
          if (typeof sessionId === 'string') this.listeners.get(sessionId)?.(event);
        }
      }
    } catch {
      // Aborted, or the connection broke: either way the stream is over.
    }
    accept();
    this.lose();
  }

  private lose(): void {
    if (this.ended) return;
    const listeners = [...this.listeners.values()];
    this.close();
    this.onLost?.();
    for (const listener of listeners) listener({ type: CONNECTION_LOST });
  }

  private armSilence(): void {
    clearTimeout(this.silence);
    this.silence = setTimeout(() => this.lose(), SILENCE_MS);
    this.silence.unref();
  }
}

const parseFrame = (frame: string): OpenCodeEvent | null => {
  // Comment lines (`: heartbeat`) carry nothing but liveness.
  const data = frame.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
  if (data === '') return null;
  try {
    const event = JSON.parse(data) as OpenCodeEvent;
    return typeof event?.type === 'string' ? event : null;
  } catch {
    return null;
  }
};

// ─── Sharing it ─────────────────────────────────────────────────────────────

/**
 * The one connection fast mode's OpenCode sessions share, opened on the
 * first `acquire` and closed when the last user releases it. A lost
 * connection is replaced on the next `acquire`.
 */
export class OpenCodeService {
  private connection: Promise<OpenCodeConnection> | null = null;
  private users = 0;
  private shutDown = false;
  private grace: NodeJS.Timeout | undefined;

  constructor(
    private readonly discover: () => Promise<ServiceAddress>,
    /** Runs on each new connection, in the background. */
    private readonly onConnect: (connection: OpenCodeConnection) => void = () => {},
    private readonly graceMs = CONNECTION_GRACE_MS,
  ) {}

  async acquire(): Promise<OpenCodeConnection> {
    if (this.shutDown) throw new OpenCodeServiceError({ kind: 'failed', reason: 'Shelly is shutting down.' });
    this.users++;
    clearTimeout(this.grace);
    this.grace = undefined;
    try {
      const pending = (this.connection ??= this.connect());
      const connection = await pending;
      if (this.shutDown) throw new OpenCodeServiceError({ kind: 'failed', reason: 'Shelly is shutting down.' });
      return connection;
    } catch (error) {
      this.release();
      throw error;
    }
  }

  /** Let go of the connection; it closes once nobody has used it for the grace period. */
  release(): void {
    this.users = Math.max(0, this.users - 1);
    if (this.users > 0 || !this.connection) return;
    clearTimeout(this.grace);
    this.grace = setTimeout(() => {
      this.grace = undefined;
      if (this.users === 0) this.drop();
    }, this.graceMs);
    this.grace.unref();
  }

  close(): void {
    this.shutDown = true;
    clearTimeout(this.grace);
    this.drop();
  }

  private drop(): void {
    const pending = this.connection;
    this.connection = null;
    void pending?.then((connection) => connection.close(), () => {});
  }

  private connect(): Promise<OpenCodeConnection> {
    const pending: Promise<OpenCodeConnection> = this.discover()
      .then((address) => OpenCodeConnection.open(address))
      .then((connection) => {
        connection.onLost = () => {
          if (this.connection === pending) this.connection = null;
        };
        this.onConnect(connection);
        return connection;
      });
    // A failed attempt is not kept: the next acquire tries again.
    pending.catch(() => {
      if (this.connection === pending) this.connection = null;
    });
    return pending;
  }
}
