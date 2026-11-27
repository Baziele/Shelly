import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { findExecutable } from './executable.js';
import {
  CONNECTION_LOST,
  type OpenCodeConnection,
  type OpenCodeEvent,
  OpenCodeHttpError,
  type OpenCodeService,
  OpenCodeServiceError,
} from './opencode-server.js';
import type { FastBackend, FastWorker, Turn, TurnHandlers, WorkerFailure } from './worker.js';

/*
 * Fast mode's OpenCode backend: sessions on OpenCode's background service,
 * over its HTTP API, run by a Shelly agent with no tools.
 *
 * The agent, `shelly-fast`, is defined in an opencode.json in Shelly's own
 * folder (`$SHELLY_HOME/fast/opencode`), which is where the sessions live:
 * the user's config is never touched, and the agent's system prompt
 * replaces OpenCode's long default one (input drops from about 14k tokens
 * to under 1.5k). The same file turns off OpenCode's title generation,
 * which would otherwise run a model call before every first reply.
 *
 * A worker is one session, made ahead of the request it serves. Sessions
 * are cheap (about 15 ms), so each conversation gets its own; each is
 * deleted when its worker ends, so none piles up in the user's session
 * list. Measured warm: first token 0.75 s with claude-haiku-5-5.
 */

export const NOT_INSTALLED = "OpenCode isn't installed, or `opencode` isn't on your PATH. Install it from https://opencode.ai.";
export const SIGNED_OUT = "OpenCode isn't signed in to the fast-mode model's provider. Run `opencode auth login`.";
export const AGENT_ID = 'shelly-fast';

const unavailableModel = (model: string, detail: string): string =>
  `OpenCode can't use ${model} for fast mode${detail ? ` (${detail})` : ''}. Sign in with \`opencode auth login\`, or set agents.opencode.fastModel in Shelly's config to a model from \`opencode models\`.`;

/** How long an interrupted turn may take to end before its session is dropped instead. */
const INTERRUPT_GRACE_MS = 2000;
const DELETE_TIMEOUT_MS = 5000;

export const findOpenCodeExecutable = (explicit: string | null, env: NodeJS.ProcessEnv): string | null => {
  const home = env.HOME || homedir();
  return findExecutable('opencode', explicit, env, [join(home, '.opencode', 'bin', 'opencode')]);
};

/** The opencode.json in Shelly's folder. Legacy-style keys, which 2.x reads too. */
export const fastAgentConfig = (systemPrompt: string) => ({
  $schema: 'https://opencode.ai/config.json',
  agent: {
    [AGENT_ID]: {
      mode: 'primary',
      description: 'Shelly fast mode: one command or a short answer, no tools.',
      prompt: systemPrompt,
      permission: { '*': 'deny' },
    },
    title: { disable: true },
  },
});

/** Write the config, only when it changed: the service reloads it on every write. */
export const writeFastAgentConfig = (cwd: string, systemPrompt: string): void => {
  mkdirSync(cwd, { recursive: true });
  const path = join(cwd, 'opencode.json');
  const text = `${JSON.stringify(fastAgentConfig(systemPrompt), null, 2)}\n`;
  let current: string | null = null;
  try {
    current = readFileSync(path, 'utf8');
  } catch {
    // Not written yet.
  }
  if (current !== text) writeFileSync(path, text);
};

/** `provider/model`, split at the first slash; null when there is none. */
export const parseModel = (model: string): { readonly providerID: string; readonly id: string } | null => {
  const slash = model.indexOf('/');
  if (slash <= 0 || slash === model.length - 1) return null;
  return { providerID: model.slice(0, slash), id: model.slice(slash + 1) };
};

/**
 * Delete the sessions an earlier daemon left behind in Shelly's folder (it
 * crashed, say). Only sessions made before this connection opened: one this
 * daemon is making right now may not be registered yet.
 */
export const sweepSessions = async (connection: OpenCodeConnection, cwd: string, keep: () => ReadonlySet<string>): Promise<void> => {
  try {
    const page = await connection.request<{ data?: { id?: unknown; location?: { directory?: unknown }; time?: { created?: unknown } }[] }>(
      'GET',
      `/api/session?directory=${encodeURIComponent(cwd)}&limit=100`,
    );
    for (const session of page?.data ?? []) {
      const created = session.time?.created;
      if (typeof session.id !== 'string' || session.location?.directory !== cwd || keep().has(session.id)) continue;
      if (typeof created !== 'number' || created >= connection.openedAt) continue;
      await connection.request('DELETE', `/api/session/${encodeURIComponent(session.id)}`, undefined, DELETE_TIMEOUT_MS).catch(() => {});
    }
  } catch {
    // Housekeeping only.
  }
};

export interface OpenCodeBackendOptions {
  /** A path or a name to find on PATH; null finds `opencode`. */
  readonly executable: string | null;
  /** `provider/model`. */
  readonly model: string;
  /** Shelly's folder for these sessions, holding the agent's opencode.json. */
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly systemPrompt: string;
  /** A turn with no event for this long fails and its session is dropped. */
  readonly noOutputTimeoutMs: number;
  /** The shared connection; the FastService owns it. */
  readonly service: OpenCodeService;
  /** The ids of every live fast session, so a sweep spares them. */
  readonly sessions: Set<string>;
}

export const makeOpenCodeBackend = (options: OpenCodeBackendOptions): FastBackend => ({
  key: `opencode\0${options.executable ?? ''}\0${options.model}\0${options.systemPrompt.length}`,
  spawn: () => {
    if (findOpenCodeExecutable(options.executable, options.env) === null) return { kind: 'unavailable', reason: NOT_INSTALLED };
    const model = parseModel(options.model);
    if (model === null) {
      return { kind: 'unavailable', reason: `Fast mode's OpenCode model must look like provider/model, not "${options.model}". Fix agents.opencode.fastModel in Shelly's config.` };
    }
    try {
      writeFastAgentConfig(options.cwd, options.systemPrompt);
    } catch {
      return { kind: 'failed', reason: `Shelly couldn't create its fast-mode folder at ${options.cwd}.` };
    }
    return new OpenCodeWorker(options, model);
  },
});

// ─── The worker ─────────────────────────────────────────────────────────────

const AUTH_FAILURE = /auth|unauthori[sz]ed|api[ ._-]?key|credential|forbidden/i;

const firstLine = (text: string, max = 200): string => {
  const line = text.trim().split('\n').find((candidate) => candidate.trim() !== '')?.trim() ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

interface ActiveTurn {
  readonly message: string;
  readonly handlers: TurnHandlers;
  text: string;
  /** The prompt has been sent, so ending it early needs an interrupt. */
  posted: boolean;
  /** Cancelled by the caller: finish quietly. */
  cancelled: boolean;
  finished: boolean;
}

interface ExecutionError {
  readonly type?: unknown;
  readonly message?: unknown;
  readonly status?: unknown;
}

const failureOf = (model: string, error: ExecutionError | undefined): WorkerFailure => {
  const type = typeof error?.type === 'string' ? error.type : '';
  const message = typeof error?.message === 'string' ? firstLine(error.message) : '';
  if (type === 'provider.no-route') return { kind: 'unavailable', reason: unavailableModel(model, message) };
  if (error?.status === 401 || error?.status === 403 || AUTH_FAILURE.test(type) || /not (?:logged|signed) in/i.test(message)) {
    return { kind: 'unavailable', reason: SIGNED_OUT };
  }
  return { kind: 'failed', reason: message ? `OpenCode failed: ${message}` : "OpenCode couldn't answer." };
};

const httpFailure = (error: unknown, what: string): WorkerFailure => {
  if (error instanceof OpenCodeServiceError) return error.failure;
  if (error instanceof OpenCodeHttpError) {
    let detail = '';
    try {
      const body = JSON.parse(error.body) as { message?: unknown; error?: { message?: unknown } };
      const message = body.message ?? body.error?.message;
      if (typeof message === 'string') detail = firstLine(message);
    } catch {
      detail = firstLine(error.body);
    }
    return { kind: 'failed', reason: `OpenCode couldn't ${what} (HTTP ${error.status}${detail ? `: ${detail}` : ''}).` };
  }
  return { kind: 'failed', reason: `OpenCode couldn't ${what}: its background service stopped answering.` };
};

class OpenCodeWorker implements FastWorker {
  readonly pid = undefined;
  readonly exited: Promise<void>;
  private resolveExited!: () => void;
  private connection: OpenCodeConnection | null = null;
  private sessionId: string | null = null;
  private unlisten: () => void = () => {};
  private phase: 'setting-up' | 'ready' | 'closing' | 'exited' = 'setting-up';
  private killed = false;
  private dead = false;
  private current: ActiveTurn | null = null;
  private pending: ActiveTurn | null = null;
  private outputTimer: NodeJS.Timeout | undefined;
  private interruptTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly options: OpenCodeBackendOptions,
    private readonly model: { readonly providerID: string; readonly id: string },
  ) {
    this.exited = new Promise((resolve) => (this.resolveExited = resolve));
    void this.setUp();
  }

  get alive(): boolean {
    return !this.killed && !this.dead;
  }

  send(message: string, handlers: TurnHandlers): Turn {
    const turn: ActiveTurn = { message, handlers, text: '', posted: false, cancelled: false, finished: false };
    if (!this.alive) {
      turn.finished = true;
      queueMicrotask(() => handlers.onFailure({ kind: 'failed', reason: 'OpenCode stopped unexpectedly.' }));
      return { cancel: () => {} };
    }

    if (this.pending) this.fail(this.pending, { kind: 'failed', reason: 'Replaced by a newer request.' });
    const running = this.current;
    if (running && !running.cancelled) {
      this.fail(running, { kind: 'failed', reason: 'Replaced by a newer request.' });
      this.interrupt(running);
    }
    if (this.current) this.pending = turn;
    else this.start(turn);
    return { cancel: () => this.cancel(turn) };
  }

  kill(): void {
    if (this.killed) return;
    this.killed = true;
    this.shutDown({ kind: 'failed', reason: 'Fast mode stopped.' });
  }

  // ─── The session ────────────────────────────────────────────────────────

  private async setUp(): Promise<void> {
    let connection: OpenCodeConnection;
    try {
      connection = await this.options.service.acquire();
    } catch (error) {
      this.settledSetUp(null, null, httpFailure(error, 'start'));
      return;
    }
    if (!this.alive) {
      this.settledSetUp(connection, null, null);
      return;
    }
    let sessionId: string;
    try {
      const created = await connection.request<{ data?: { id?: unknown } }>('POST', '/api/session', {
        agent: AGENT_ID,
        model: this.model,
        location: { directory: this.options.cwd },
        permissions: [{ action: '*', resource: '*', effect: 'deny' }],
      });
      const id = created?.data?.id;
      if (typeof id !== 'string') throw new Error('no session id');
      sessionId = id;
    } catch (error) {
      this.settledSetUp(connection, null, httpFailure(error, 'start a session'));
      return;
    }
    this.settledSetUp(connection, sessionId, null);
  }

  private settledSetUp(connection: OpenCodeConnection | null, sessionId: string | null, failure: WorkerFailure | null): void {
    this.connection = connection;
    this.sessionId = sessionId;
    if (sessionId !== null) this.options.sessions.add(sessionId);
    this.phase = 'ready';
    if (failure) {
      this.shutDown(failure);
      return;
    }
    if (!this.alive) {
      // Killed while setting up: kill() left the cleanup to here.
      this.cleanUp(null);
      return;
    }
    this.unlisten = connection!.listen(sessionId!, (event) => this.onEvent(event));
    if (this.current && !this.current.posted) this.post(this.current);
  }

  /** End the worker: fail its turns with `failure`, then interrupt and delete the session. */
  private shutDown(failure: WorkerFailure): void {
    this.dead = true;
    this.clearTimers();
    const running = this.current;
    for (const turn of [this.current, this.pending]) {
      if (turn) this.fail(turn, failure);
    }
    this.current = null;
    this.pending = null;
    // Still setting up: settledSetUp cleans up once there is something to clean.
    if (this.phase === 'ready') this.cleanUp(running);
  }

  private cleanUp(running: ActiveTurn | null): void {
    if (this.phase !== 'ready') return;
    this.phase = 'closing';
    const { connection, sessionId } = this;
    this.connection = null;
    this.sessionId = null;
    this.unlisten();
    void (async () => {
      if (connection && sessionId !== null) {
        const path = `/api/session/${encodeURIComponent(sessionId)}`;
        if (running?.posted && !connection.closed) {
          await connection.request('POST', `${path}/interrupt`, undefined, DELETE_TIMEOUT_MS).catch(() => {});
        }
        if (!connection.closed) await connection.request('DELETE', path, undefined, DELETE_TIMEOUT_MS).catch(() => {});
        this.options.sessions.delete(sessionId);
      }
      if (connection) this.options.service.release();
      this.phase = 'exited';
      this.resolveExited();
    })();
  }

  // ─── Turns ──────────────────────────────────────────────────────────────

  private start(turn: ActiveTurn): void {
    this.current = turn;
    // The clock covers setting up the session too: a stuck service fails the request.
    this.armOutputTimer();
    if (this.sessionId !== null) this.post(turn);
  }

  private post(turn: ActiveTurn): void {
    const connection = this.connection;
    const sessionId = this.sessionId;
    if (!connection || !sessionId) return;
    turn.posted = true;
    connection.request('POST', `/api/session/${encodeURIComponent(sessionId)}/prompt`, { text: turn.message }).catch((error: unknown) => {
      if (this.current !== turn) return;
      this.fail(turn, httpFailure(error, 'take the request'));
      this.next();
    });
  }

  private cancel(turn: ActiveTurn): void {
    if (turn.finished) return;
    turn.cancelled = true;
    turn.finished = true;
    if (this.pending === turn) this.pending = null;
    else if (this.current === turn) this.interrupt(turn);
  }

  /** Ask OpenCode to stop the running turn; it ends it with `execution.interrupted`. */
  private interrupt(turn: ActiveTurn): void {
    turn.cancelled = true;
    if (this.interruptTimer || this.current !== turn) return;
    clearTimeout(this.outputTimer);
    if (!turn.posted) {
      // Nothing reached OpenCode yet.
      this.next();
      return;
    }
    const connection = this.connection;
    if (connection && this.sessionId) {
      connection.request('POST', `/api/session/${encodeURIComponent(this.sessionId)}/interrupt`).catch(() => {});
    }
    this.interruptTimer = setTimeout(() => this.kill(), INTERRUPT_GRACE_MS);
    this.interruptTimer.unref();
  }

  private fail(turn: ActiveTurn, failure: WorkerFailure): void {
    if (turn.finished) return;
    turn.finished = true;
    turn.cancelled = true;
    turn.handlers.onFailure(failure);
  }

  /** The running turn is over: start the waiting one, if any. */
  private next(): void {
    this.current = null;
    this.clearTimers();
    const pending = this.pending;
    this.pending = null;
    if (pending && this.alive) this.start(pending);
  }

  private onEvent(event: OpenCodeEvent): void {
    if (event.type === CONNECTION_LOST) {
      if (!this.dead) this.shutDown({ kind: 'failed', reason: 'OpenCode stopped unexpectedly: its background service went away.' });
      return;
    }
    const turn = this.current;
    if (turn && !this.interruptTimer) this.armOutputTimer();
    const data = event.data ?? {};

    switch (event.type) {
      case 'session.text.delta': {
        const delta = typeof data.delta === 'string' ? data.delta : '';
        if (!turn || delta === '') return;
        turn.text += delta;
        if (!turn.finished) turn.handlers.onDelta(delta);
        return;
      }
      case 'session.text.ended': {
        // The whole text of one part: covers a reply that came without deltas.
        if (turn && turn.text === '' && typeof data.text === 'string') turn.text = data.text;
        return;
      }
      case 'permission.asked': {
        // The agent has no tools, so nothing should ask; refuse whatever does.
        const connection = this.connection;
        if (connection && this.sessionId && typeof data.id === 'string') {
          const path = `/api/session/${encodeURIComponent(this.sessionId)}/permission/${encodeURIComponent(data.id)}/reply`;
          connection.request('POST', path, { decision: 'reject', message: 'Fast mode has no tools.' }).catch(() => {});
        }
        return;
      }
      case 'session.execution.succeeded':
        if (!turn) return;
        if (!turn.finished) {
          turn.finished = true;
          turn.handlers.onDone(turn.text);
        }
        this.next();
        return;
      case 'session.execution.failed':
        if (!turn) return;
        this.fail(turn, failureOf(`${this.model.providerID}/${this.model.id}`, data.error as ExecutionError | undefined));
        this.next();
        return;
      case 'session.execution.interrupted':
        if (!turn) return;
        this.fail(turn, { kind: 'failed', reason: 'OpenCode stopped the request.' });
        this.next();
        return;
    }
  }

  private armOutputTimer(): void {
    clearTimeout(this.outputTimer);
    this.outputTimer = setTimeout(() => {
      const turn = this.current;
      if (turn) {
        const seconds = Math.round(this.options.noOutputTimeoutMs / 1000);
        this.fail(turn, { kind: 'failed', reason: `OpenCode didn't answer within ${seconds} seconds.` });
      }
      this.kill();
    }, this.options.noOutputTimeoutMs);
    this.outputTimer.unref();
  }

  private clearTimers(): void {
    clearTimeout(this.outputTimer);
    clearTimeout(this.interruptTimer);
    this.outputTimer = undefined;
    this.interruptTimer = undefined;
  }
}
