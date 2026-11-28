import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { DaemonClient } from '../../src/client/daemon-client.js';
import type { DaemonLink } from '../../src/client/daemon-link.js';
import type { FastEvent, ThreadEvent, ThreadSummary } from '../../src/protocol/schema.js';
import type { ShellSessionOptions } from '../../src/shell/shell-session.js';
import type { HostTerminal } from '../../src/terminal/host-terminal.js';

/*
 * The real Shelly (real overlay, real flows, real AgentView) between a fake
 * terminal, a fake shell that speaks the hooks' markers, and a fake daemon
 * client whose calls the test resolves by hand: races in the client
 * integration (a slow daemon, keys typed at the wrong moment), without a
 * daemon, a pty or an agent. See src/client/flow-races.test.ts.
 */

export const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((r, j) => {
    resolve = r;
    reject = j;
  });
  return { promise, resolve, reject };
};

/** An async iterable the test pushes events into. */
export class Feed<T> implements AsyncIterable<T> {
  private queue: IteratorResult<T>[] = [];
  private waiting: ((result: IteratorResult<T>) => void) | undefined;
  private failure: unknown;
  returned = false;
  push(value: T): void {
    this.deliver({ done: false, value });
  }
  end(): void {
    this.deliver({ done: true, value: undefined });
  }
  fail(error: unknown): void {
    this.failure = error;
    const waiting = this.waiting;
    this.waiting = undefined;
    // Rejects the next read.
    if (waiting) {
      (waiting as unknown as { reject: (e: unknown) => void }).reject?.(error);
    }
  }
  private deliver(result: IteratorResult<T>): void {
    if (this.waiting) {
      const waiting = this.waiting;
      this.waiting = undefined;
      waiting(result);
    } else {
      this.queue.push(result);
    }
  }
  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.failure) {
          return Promise.reject(this.failure);
        }
        const queued = this.queue.shift();
        if (queued) {
          return Promise.resolve(queued);
        }
        return new Promise((resolve, reject) => {
          const waiting = resolve as ((result: IteratorResult<T>) => void) & { reject?: (e: unknown) => void };
          waiting.reject = reject;
          this.waiting = waiting;
        });
      },
      return: () => {
        this.returned = true;
        this.deliver({ done: true, value: undefined });
        return Promise.resolve({ done: true, value: undefined });
      },
    };
  }
}

export const summary = (id: string, overrides: Partial<ThreadSummary> = {}): ThreadSummary => ({
  id, title: `thread ${id}`, agentId: 'fake', location: 'home', cwd: '/home', createdAt: 0, updatedAt: 0, status: 'idle', turnCount: 1, attachedBy: null,
  ...overrides,
});

export interface FakeDaemon {
  client: DaemonClient;
  /** Every call, by name, in order. */
  calls: string[];
  /** Replace a method (e.g. to make it slow). */
  override: Partial<Record<keyof DaemonClient, (...args: never[]) => unknown>>;
  prompts: { threadId: string; text: string; context: unknown; feed: Feed<ThreadEvent> }[];
  watches: { threadId: string; afterSeq: number; feed: Feed<ThreadEvent> }[];
  fast: { sessionKey: string; feed: Feed<FastEvent> }[];
}

export const fakeDaemon = (): FakeDaemon => {
  const calls: string[] = [];
  const override: FakeDaemon['override'] = {};
  const prompts: FakeDaemon['prompts'] = [];
  const watches: FakeDaemon['watches'] = [];
  const fast: FakeDaemon['fast'] = [];
  let threads = 0;
  const base: Record<string, (...args: never[]) => unknown> = {
    connect: () => Promise.resolve({ protocolVersion: 2, daemonVersion: '0', pid: 1 }),
    listAgents: () => Promise.resolve([{ id: 'fake', name: 'Fake', available: true, unavailableReason: null, supportsFast: true, isDefault: true }]),
    prewarmThread: () => Promise.resolve(),
    prewarmFast: () => Promise.resolve(),
    createThread: () => Promise.resolve(summary(`t${++threads}`)),
    attachThread: (id: string) => Promise.resolve({ thread: summary(id), history: [] }),
    detachThread: () => Promise.resolve(),
    listThreads: () => Promise.resolve([summary('old')]),
    threadModes: () => Promise.resolve(null),
    cancel: () => Promise.resolve(),
    respond: () => Promise.resolve(),
    endFast: () => Promise.resolve(),
    setDefaultAgent: () => Promise.resolve(),
    prompt: (threadId: string, text: string, context: unknown) => {
      const feed = new Feed<ThreadEvent>();
      prompts.push({ threadId, text, context, feed });
      return feed;
    },
    watch: (threadId: string, afterSeq: number) => {
      const feed = new Feed<ThreadEvent>();
      watches.push({ threadId, afterSeq, feed });
      return feed;
    },
    fastRequest: ({ sessionKey }: { sessionKey: string }) => {
      const feed = new Feed<FastEvent>();
      fast.push({ sessionKey, feed });
      return feed;
    },
    dispose: () => Promise.resolve(),
  };
  const client = new Proxy({}, {
    get: (_target, name: string) => {
      const method = (override as Record<string, unknown>)[name] ?? base[name];
      if (typeof method !== 'function') {
        return undefined;
      }
      return (...args: never[]) => {
        calls.push(name);
        return (method as (...a: never[]) => unknown)(...args);
      };
    },
  }) as unknown as DaemonClient;
  return { client, calls, override, prompts, watches, fast };
};

export interface Rig {
  daemon: FakeDaemon;
  shelly: unknown;
  mode(): string;
  written(): string;
  toShell: string[];
  /** What the fake shell's input line would hold: printable keys since the last Enter/Ctrl-C, and executed lines. */
  shellLine(): string;
  executed: string[];
  type(data: string): void;
  resize(size: { cols: number; rows: number }): void;
  prompt(): void;
  shellOutput(data: string): void;
  marker(kind: string, payload: string): string;
  /** How many times Shelly asked the terminal where the cursor is. */
  cursorQueries(): number;
  stop(): Promise<void>;
}

export const startRig = async (options: { shell?: string; features?: string; cursorQuery?: () => Promise<{ row: number; col: number }> } = {}): Promise<Rig> => {
  const { Shelly } = await import('../../src/shelly.js');
  const home = mkdtempSync(join(tmpdir(), 'shelly-rig-'));
  let onInput: (data: string) => void = () => undefined;
  let written = '';
  let resize: (size: { cols: number; rows: number }) => void = () => undefined;
  let cursorQueries = 0;
  const host = {
    size: { cols: 100, rows: 30 },
    start: (listener: (data: string) => void) => (onInput = listener),
    stop: () => undefined,
    onResize: (listener: (size: { cols: number; rows: number }) => void) => {
      resize = listener;
      return () => undefined;
    },
    write: (data: string) => (written += data),
    queryCursorPosition: () => {
      cursorQueries++;
      return (options.cursorQuery ?? (() => Promise.resolve({ row: 5, col: 3 })))();
    },
  } as unknown as HostTerminal;

  const toShell: string[] = [];
  const executed: string[] = [];
  let line = '';
  let shellOutput: (data: string) => void = () => undefined;
  let exit: (code: number) => void = () => undefined;
  let nonce = '';
  const spawnShell = (spawnOptions: ShellSessionOptions) => {
    nonce = String(spawnOptions.env.SHELLY_NONCE ?? '');
    return {
      onData: (listener: (data: string) => void) => (shellOutput = listener),
      onExit: (listener: (code: number) => void) => (exit = listener),
      write: (data: string) => {
        toShell.push(data);
        // A crude line editor: Enter runs the line, Ctrl-C clears it.
        for (const ch of data.replace(/\u001b\[[0-9;]*[~A-Za-z]/g, '')) {
          if (ch === '\r' || ch === '\n') {
            if (line) executed.push(line);
            line = '';
          } else if (ch === '\u0003') {
            line = '';
          } else if (ch >= ' ') {
            line += ch;
          }
        }
      },
      resize: () => undefined,
      kill: () => exit(0),
      isShellInForeground: () => true,
    };
  };
  const daemon = fakeDaemon();
  const link = {
    startDaemon: () => Promise.resolve(),
    get: () => Promise.resolve(daemon.client),
    reconnect: () => daemon.client.connect(),
    dispose: () => Promise.resolve(),
    get loaded() {
      return daemon.client;
    },
    lastError: undefined,
  } as unknown as DaemonLink;

  const shelly = new Shelly({ host, shell: options.shell ?? '/bin/zsh', cwd: home, env: { HOME: home, PATH: process.env.PATH ?? '' }, link, spawnShell });
  const running = shelly.run();
  const internals = shelly as unknown as { mode: string; overlayLoad: Promise<unknown> };
  await internals.overlayLoad;
  const marker = (kind: string, payload: string) => `\u001b]6973;${nonce};${kind};${payload}\u0007`;
  const rig: Rig = {
    daemon,
    shelly,
    mode: () => internals.mode,
    written: () => written,
    toShell,
    executed,
    shellLine: () => line,
    type: (data) => onInput(data),
    resize: (size) => {
      (host as { size: { cols: number; rows: number } }).size = size;
      resize(size);
    },
    prompt: () => shellOutput(`${marker('cwd', encodeURIComponent(home))}$ `),
    shellOutput: (data) => shellOutput(data),
    marker,
    cursorQueries: () => cursorQueries,
    stop: async () => {
      shelly.terminate();
      await running;
      rmSync(home, { recursive: true, force: true });
    },
  };
  shellOutput(marker('line-editor', options.features ?? 'capture,set,notice'));
  rig.prompt();
  await sleep(10);
  return rig;
};

/** Type one key per read, as a person does. */
export const typeKeys = async (rig: Rig, text: string, gapMs = 5): Promise<void> => {
  for (const ch of text) {
    rig.type(ch);
    await sleep(gapMs);
  }
};

export const until = async (predicate: () => boolean, what: string, timeoutMs = 2000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await sleep(5);
  }
};

export { sleep };
