import { type ChildProcess, spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { findExecutable } from './executable.js';
import type { FastBackend, FastWorker, Turn, TurnHandlers, WorkerFailure } from './worker.js';

/*
 * Fast mode's Claude backend: `claude -p` speaking stream-json, stripped of
 * everything that costs start-up time (tools, MCP, settings, slash commands,
 * the default system prompt, session files). Measured: first token about
 * 0.7 s after the request when warm, 1.4 s cold.
 *
 * Not `--bare`: it turns off the subscription (OAuth) login.
 */

export const NOT_INSTALLED = "Claude Code isn't installed, or `claude` isn't on your PATH. Install it from https://claude.com/claude-code.";
export const SIGNED_OUT = "Claude Code isn't signed in. Run `claude` once to sign in.";

/** How long an interrupted turn may take to end before the worker is killed instead. */
const INTERRUPT_GRACE_MS = 2000;
/** After SIGTERM, how long the group gets before SIGKILL. */
const KILL_GRACE_MS = 1500;
const STDERR_TAIL_CHARS = 4096;

/*
 * A Claude Code session that started the daemon (or Shelly inside it)
 * exports these; a claude spawned with them acts as part of that session.
 * The list follows T3 Code's (MIT). Auth settings such as
 * CLAUDE_CODE_OAUTH_TOKEN or CLAUDE_CODE_USE_BEDROCK are the user's and stay.
 */
const HOST_SESSION_VARIABLES = [
  'CLAUDECODE',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_HOST_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_CHILD_NOTES_DIR',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_DESKTOP_APP_VERSION',
  'CLAUDE_EFFORT',
  'CLAUDE_PID',
  'CLAUDE_AGENT_SDK_VERSION',
  // Commands an Electron host runs inherit this and would start as plain Node.
  'ELECTRON_RUN_AS_NODE',
];

export const claudeEnvironment = (base: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const name of HOST_SESSION_VARIABLES) delete env[name];
  // A pool of background workers should never race to update the user's CLI.
  env.DISABLE_AUTOUPDATER = '1';
  return env;
};

export const claudeArgs = (model: string, systemPrompt: string): string[] => [
  '-p',
  '--input-format', 'stream-json',
  '--output-format', 'stream-json',
  '--include-partial-messages',
  '--verbose',
  '--no-session-persistence',
  '--model', model,
  '--effort', 'low',
  '--tools', '',
  '--strict-mcp-config',
  '--setting-sources', '',
  '--disable-slash-commands',
  '--system-prompt', systemPrompt,
];

/**
 * The claude executable to run: `explicit` when it is a path, else the
 * first match on PATH, else the installer's usual places. Null when none.
 */
export const findClaudeExecutable = (explicit: string | null, env: NodeJS.ProcessEnv): string | null => {
  const home = env.HOME || homedir();
  return findExecutable('claude', explicit, env, [join(home, '.local', 'bin', 'claude'), join(home, '.claude', 'local', 'claude')]);
};

export interface ClaudeBackendOptions {
  /** A path or a name to find on PATH; null finds `claude`. */
  readonly executable: string | null;
  readonly model: string;
  /** An empty folder of Shelly's, so no project's CLAUDE.md or settings apply. */
  readonly cwd: string;
  /** The daemon's environment, before cleaning. */
  readonly env: NodeJS.ProcessEnv;
  readonly systemPrompt: string;
  /** A turn with no output for this long fails and its worker is killed. */
  readonly noOutputTimeoutMs: number;
}

export const makeClaudeBackend = (options: ClaudeBackendOptions): FastBackend => ({
  key: `claude\0${options.executable ?? ''}\0${options.model}\0${options.systemPrompt.length}`,
  spawn: () => {
    const executable = findClaudeExecutable(options.executable, options.env);
    if (executable === null) return { kind: 'unavailable', reason: NOT_INSTALLED };
    try {
      mkdirSync(options.cwd, { recursive: true });
    } catch {
      return { kind: 'failed', reason: `Shelly couldn't create its fast-mode folder at ${options.cwd}.` };
    }
    return new ClaudeWorker(executable, options);
  },
});

// ─── The worker ─────────────────────────────────────────────────────────────

const AUTH_FAILURE = /not logged in|please run \/login|invalid api key|authentication[_ ]failed|authentication_error|oauth token (?:has )?(?:expired|been revoked)|invalid bearer token/i;

const firstLine = (text: string, max = 200): string => {
  const line = text.trim().split('\n').find((candidate) => candidate.trim() !== '')?.trim() ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

const lastLine = (text: string, max = 200): string => {
  const lines = text.trim().split('\n').filter((candidate) => candidate.trim() !== '');
  return firstLine(lines.at(-1) ?? '', max);
};

interface ActiveTurn {
  readonly message: string;
  readonly handlers: TurnHandlers;
  text: string;
  /** The assistant message's error tag, such as `authentication_failed`. */
  error: string | null;
  /** Cancelled by the caller: finish quietly. */
  cancelled: boolean;
  finished: boolean;
}

/** One stream-json message; only the fields read here. */
interface ClaudeMessage {
  readonly type?: string;
  readonly subtype?: string;
  readonly is_error?: boolean;
  readonly result?: unknown;
  readonly errors?: unknown;
  readonly error?: unknown;
  readonly parent_tool_use_id?: string | null;
  readonly event?: { readonly delta?: { readonly type?: string; readonly text?: string } };
}

class ClaudeWorker implements FastWorker {
  readonly pid: number | undefined;
  readonly exited: Promise<void>;
  private readonly child: ChildProcess;
  private readonly timeoutMs: number;
  private killed = false;
  private hasExited = false;
  private stdoutBuffer = '';
  private stderrTail = '';
  private current: ActiveTurn | null = null;
  private pending: ActiveTurn | null = null;
  private outputTimer: NodeJS.Timeout | undefined;
  private interruptTimer: NodeJS.Timeout | undefined;
  private resolveExited!: () => void;
  private nextRequestId = 0;

  constructor(executable: string, options: ClaudeBackendOptions) {
    this.timeoutMs = options.noOutputTimeoutMs;
    this.exited = new Promise((resolve) => (this.resolveExited = resolve));
    // Its own process group, so kill reaches anything the CLI starts; it can outlive its pipes.
    this.child = spawn(executable, claudeArgs(options.model, options.systemPrompt), {
      cwd: options.cwd,
      env: claudeEnvironment(options.env),
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    });
    this.pid = this.child.pid;

    // Every pipe is drained, so a chatty CLI never blocks on a full pipe.
    this.child.stdout!.setEncoding('utf8').on('data', (chunk: string) => this.onStdout(chunk));
    this.child.stderr!.setEncoding('utf8').on('data', (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL_CHARS);
    });
    this.child.stdin!.on('error', () => {});
    this.child.stdout!.on('error', () => {});
    this.child.stderr!.on('error', () => {});
    this.child.once('error', (error: NodeJS.ErrnoException) => {
      this.onExit(error.code === 'ENOENT' ? { kind: 'unavailable', reason: NOT_INSTALLED } : null, null, null);
    });
    this.child.once('exit', (code, signal) => this.onExit(null, code, signal));
  }

  get alive(): boolean {
    return !this.killed && !this.hasExited;
  }

  send(message: string, handlers: TurnHandlers): Turn {
    const turn: ActiveTurn = { message, handlers, text: '', error: null, cancelled: false, finished: false };
    if (!this.alive) {
      turn.finished = true;
      queueMicrotask(() => handlers.onFailure({ kind: 'failed', reason: 'Claude Code stopped unexpectedly.' }));
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
    if (this.killed || this.hasExited) return;
    this.killed = true;
    this.clearTimers();
    for (const turn of [this.current, this.pending]) {
      if (turn) this.fail(turn, { kind: 'failed', reason: 'Fast mode stopped.' });
    }
    this.signalGroup('SIGTERM');
    this.child.stdin!.end();
    setTimeout(() => {
      if (!this.hasExited) this.signalGroup('SIGKILL');
    }, KILL_GRACE_MS).unref();
  }

  // ─── Turns ──────────────────────────────────────────────────────────────

  private start(turn: ActiveTurn): void {
    this.current = turn;
    this.write({ type: 'user', message: { role: 'user', content: turn.message } });
    this.armOutputTimer();
  }

  private cancel(turn: ActiveTurn): void {
    if (turn.finished) return;
    turn.cancelled = true;
    turn.finished = true;
    if (this.pending === turn) this.pending = null;
    else if (this.current === turn) this.interrupt(turn);
  }

  /** Ask the CLI to stop the running turn; it ends it with a `result` at once. */
  private interrupt(turn: ActiveTurn): void {
    turn.cancelled = true;
    if (this.interruptTimer || this.current !== turn) return;
    clearTimeout(this.outputTimer);
    this.write({ type: 'control_request', request_id: `shelly-interrupt-${++this.nextRequestId}`, request: { subtype: 'interrupt' } });
    this.interruptTimer = setTimeout(() => this.kill(), INTERRUPT_GRACE_MS);
    this.interruptTimer.unref();
  }

  private fail(turn: ActiveTurn, failure: WorkerFailure): void {
    if (turn.finished) return;
    turn.finished = true;
    turn.cancelled = true;
    turn.handlers.onFailure(failure);
  }

  private onResult(message: ClaudeMessage): void {
    const turn = this.current;
    if (!turn) return;
    this.current = null;
    this.clearTimers();

    if (!turn.finished) {
      const text = typeof message.result === 'string' ? message.result : '';
      if (message.is_error === true || message.subtype !== 'success') {
        this.fail(turn, this.resultFailure(turn, message));
      } else {
        turn.finished = true;
        turn.handlers.onDone(turn.text || text);
      }
    }

    const next = this.pending;
    this.pending = null;
    if (next && this.alive) this.start(next);
  }

  private resultFailure(turn: ActiveTurn, message: ClaudeMessage): WorkerFailure {
    const errors = Array.isArray(message.errors) ? message.errors.filter((e) => typeof e === 'string').join('\n') : '';
    const text = [typeof message.result === 'string' ? message.result : '', errors].join('\n').trim();
    if (turn.error === 'authentication_failed' || AUTH_FAILURE.test(text) || AUTH_FAILURE.test(this.stderrTail)) {
      return { kind: 'unavailable', reason: SIGNED_OUT };
    }
    const detail = firstLine(text);
    return { kind: 'failed', reason: detail ? `Claude Code failed: ${detail}` : "Claude Code couldn't answer." };
  }

  // ─── The process ────────────────────────────────────────────────────────

  private onStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    let newline: number;
    while ((newline = this.stdoutBuffer.indexOf('\n')) >= 0) {
      const line = this.stdoutBuffer.slice(0, newline);
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (line.trim() !== '') this.onLine(line);
    }
  }

  private onLine(line: string): void {
    let message: ClaudeMessage;
    try {
      message = JSON.parse(line) as ClaudeMessage;
    } catch {
      return;
    }
    const turn = this.current;
    if (turn && !this.interruptTimer) this.armOutputTimer();

    switch (message.type) {
      case 'stream_event': {
        const delta = message.event?.delta;
        if (!turn || message.parent_tool_use_id || delta?.type !== 'text_delta' || !delta.text) return;
        turn.text += delta.text;
        if (!turn.finished) turn.handlers.onDelta(delta.text);
        return;
      }
      case 'assistant':
        if (turn && typeof message.error === 'string') turn.error = message.error;
        return;
      case 'result':
        this.onResult(message);
        return;
    }
  }

  private onExit(failure: WorkerFailure | null, code: number | null, signal: NodeJS.Signals | null): void {
    if (this.hasExited) return;
    this.hasExited = true;
    this.clearTimers();
    // The CLI can leave children behind; nothing in its group should outlive it.
    this.signalGroup('SIGKILL');

    const reason = failure ?? this.exitFailure(code, signal);
    for (const turn of [this.current, this.pending]) {
      if (turn) this.fail(turn, reason);
    }
    this.current = null;
    this.pending = null;
    this.resolveExited();
  }

  private exitFailure(code: number | null, signal: NodeJS.Signals | null): WorkerFailure {
    if (AUTH_FAILURE.test(this.stderrTail)) return { kind: 'unavailable', reason: SIGNED_OUT };
    const how = signal ? ` (${signal})` : code !== null ? ` (exit code ${code})` : '';
    const detail = lastLine(this.stderrTail);
    return { kind: 'failed', reason: `Claude Code stopped unexpectedly${how}${detail ? `: ${detail}` : '.'}` };
  }

  private armOutputTimer(): void {
    clearTimeout(this.outputTimer);
    this.outputTimer = setTimeout(() => {
      const turn = this.current;
      if (turn) {
        const seconds = Math.round(this.timeoutMs / 1000);
        this.fail(turn, { kind: 'failed', reason: `Claude Code didn't answer within ${seconds} seconds.` });
      }
      this.kill();
    }, this.timeoutMs);
    this.outputTimer.unref();
  }

  private clearTimers(): void {
    clearTimeout(this.outputTimer);
    clearTimeout(this.interruptTimer);
    this.outputTimer = undefined;
    this.interruptTimer = undefined;
  }

  private write(message: unknown): void {
    if (this.child.stdin!.writable) this.child.stdin!.write(`${JSON.stringify(message)}\n`);
  }

  private signalGroup(signal: NodeJS.Signals): void {
    if (this.pid === undefined) return;
    try {
      process.kill(-this.pid, signal);
    } catch {
      // Already gone.
    }
  }
}
