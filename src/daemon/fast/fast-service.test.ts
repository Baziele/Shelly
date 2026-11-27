import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as Fiber from 'effect/Fiber';
import * as Layer from 'effect/Layer';
import * as ManagedRuntime from 'effect/ManagedRuntime';
import * as Stream from 'effect/Stream';
import type { FastEvent, FastInput } from '../../protocol/schema.js';
import { FastService, ShellyConfig, type ConfigFile } from '../services.js';
import { NOT_INSTALLED, SIGNED_OUT } from './claude-worker.js';
import * as Fast from './fast-service.js';

const FAKE_CLAUDE = fileURLToPath(new URL('../../../test/fixtures/fake-claude.mjs', import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'shelly-fast-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

interface LogEvent {
  readonly pid: number;
  readonly event: 'start' | 'request' | 'interrupt' | 'stdin-end';
  readonly args?: string[];
  readonly cwd?: string;
  readonly hostSession?: string[];
  readonly grandchild?: number | null;
  readonly request?: string;
}

let harnessCount = 0;

/** A FastService on the fake claude, with short timings; disposed (and checked for leftovers) by the caller. */
const harness = (options: {
  readonly settings?: Partial<Fast.FastSettingsValue>;
  readonly env?: NodeJS.ProcessEnv;
  readonly config?: ConfigFile;
} = {}) => {
  const dir = join(scratch, `h${++harnessCount}`);
  const logFile = join(dir, 'fake.log');
  const settings: Fast.FastSettingsValue = {
    fastHome: join(dir, 'fast'),
    keepWarmMs: 60_000,
    sessionIdleMs: 60_000,
    noOutputTimeoutMs: 5_000,
    claudeExecutable: FAKE_CLAUDE,
    env: { ...process.env, FAKE_CLAUDE_LOG: logFile, ...options.env },
    ...options.settings,
  };
  const config = Layer.succeed(ShellyConfig, ShellyConfig.of({
    get: Effect.succeed(options.config ?? {}),
    setDefaultAgent: () => Effect.void,
  }));
  const runtime = ManagedRuntime.make(
    Fast.layer.pipe(Layer.provide(Layer.merge(config, Layer.succeed(Fast.FastSettings, settings)))),
  );

  const events = (): LogEvent[] => {
    try {
      return readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as LogEvent);
    } catch {
      return [];
    }
  };
  const starts = () => events().filter((event) => event.event === 'start');

  const run = <A, E>(effect: Effect.Effect<A, E, FastService>) => runtime.runPromise(effect);
  const ask = (instruction: string, sessionKey = 'one', agentId = 'claude') =>
    run(FastService.use((fast) => Stream.runCollect(fast.request({ agentId, sessionKey, input: input(instruction) }))));
  const askExit = (instruction: string, sessionKey = 'one', agentId = 'claude') =>
    runtime.runPromiseExit(FastService.use((fast) => Stream.runCollect(fast.request({ agentId, sessionKey, input: input(instruction) }))));
  const workerCount = () => run(FastService.use((fast) => fast.workerCount));
  const prewarm = (agentId = 'claude') => run(FastService.use((fast) => fast.prewarm(agentId)));
  const end = (sessionKey: string) => run(FastService.use((fast) => fast.end(sessionKey)));

  /** Dispose and check that every process the fake started (and its children) is gone. */
  const dispose = async () => {
    await runtime.dispose();
    for (const start of starts()) {
      assert.equal(isRunning(start.pid), false, `worker ${start.pid} outlived the service`);
      // A killed grandchild is reparented and reaped by the system, so give it a moment.
      if (start.grandchild) await until(() => !isRunning(start.grandchild!), 2000);
    }
  };

  return { runtime, run, ask, askExit, workerCount, prewarm, end, dispose, events, starts, settings };
};

const input = (instruction: string): FastInput => ({
  instruction,
  buffer: '',
  cwd: '/tmp/project',
  environment: { os: 'macOS 25.0.0 (arm64)', shell: 'zsh', shellVersion: null, terminal: null },
  recentCommands: [],
});

const isRunning = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const until = async (condition: () => boolean | Promise<boolean>, timeoutMs = 3000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

const done = (events: readonly FastEvent[]) => {
  const last = events.at(-1);
  assert.equal(last?.type, 'done');
  return last as Extract<FastEvent, { type: 'done' }>;
};

const failure = (exit: Exit.Exit<unknown, unknown>) => {
  assert.ok(Exit.isFailure(exit), 'expected the request to fail');
  const error = exit.cause.reasons.find((reason) => reason._tag === 'Fail');
  assert.ok(error && error._tag === 'Fail', 'expected a typed failure');
  return error.error as { readonly _tag: string; readonly reason: string };
};

const pidOf = (text: string): number => Number(/pid=(\d+)/.exec(text)?.[1]);

describe('FastService on Claude', () => {
  it('streams deltas, then one done with the cleaned command', async () => {
    const fast = harness();
    try {
      const events = await fast.ask('reply: ```bash\n$ ls -la\n```');
      const deltas = events.filter((event) => event.type === 'delta');
      assert.ok(deltas.length >= 2, 'expected several deltas');
      assert.equal(deltas.map((event) => event.text).join(''), '```bash\n$ ls -la\n```');
      const last = done(events);
      assert.equal(last.text, 'ls -la');
      assert.equal(last.kind, 'command');
      assert.ok(last.durationMs >= 0);
      assert.equal(events.filter((event) => event.type === 'done').length, 1);
    } finally {
      await fast.dispose();
    }
  });

  it('classifies a `# ` reply as an answer', async () => {
    const fast = harness();
    try {
      const last = done(await fast.ask('reply: # -print0 ends each name with a NUL byte.\n# Pair it with xargs -0.'));
      assert.deepEqual([last.kind, last.text], ['answer', '-print0 ends each name with a NUL byte.\nPair it with xargs -0.']);
    } finally {
      await fast.dispose();
    }
  });

  it('starts the lean CLI in an empty folder with a clean environment', async () => {
    const fast = harness({ env: { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'host', CLAUDE_CODE_ENTRYPOINT: 'cli' } });
    try {
      await fast.ask('hello');
      const [start] = fast.starts();
      assert.deepEqual(start?.hostSession, []);
      assert.equal(start?.cwd && start.cwd.endsWith(join('fast', 'claude')), true);
      const args = start?.args ?? [];
      for (const flag of ['-p', '--no-session-persistence', '--strict-mcp-config', '--disable-slash-commands', '--include-partial-messages']) {
        assert.ok(args.includes(flag), `missing ${flag}`);
      }
      assert.equal(args[args.indexOf('--model') + 1], 'haiku');
      assert.equal(args[args.indexOf('--tools') + 1], '');
      assert.equal(args[args.indexOf('--setting-sources') + 1], '');
      assert.ok(!args.includes('--bare'), '--bare turns off the subscription login');
    } finally {
      await fast.dispose();
    }
  });

  it('uses the fast model from the config', async () => {
    const fast = harness({ config: { agents: { claude: { fastModel: 'sonnet' } } } });
    try {
      await fast.ask('hello');
      const args = fast.starts()[0]?.args ?? [];
      assert.equal(args[args.indexOf('--model') + 1], 'sonnet');
    } finally {
      await fast.dispose();
    }
  });

  it('prewarm starts one worker, at once, and only one', async () => {
    const fast = harness({ env: { FAKE_CLAUDE_STARTUP_MS: '300' } });
    try {
      const started = performance.now();
      await fast.prewarm();
      assert.ok(performance.now() - started < 200, 'prewarm should not wait for the process');
      await fast.prewarm();
      await fast.prewarm();
      assert.equal(await fast.workerCount(), 1);
      await until(() => fast.starts().length === 1);
    } finally {
      await fast.dispose();
    }
  });

  it('a request takes the warm worker and starts its replacement', async () => {
    const fast = harness();
    try {
      await fast.prewarm();
      await until(() => fast.starts().length === 1);
      const warmPid = fast.starts()[0]!.pid;
      const last = done(await fast.ask('hello'));
      assert.equal(pidOf(last.text), warmPid);
      assert.equal(await fast.workerCount(), 2, 'the session worker and a new warm one');
      await until(() => fast.starts().length === 2);

      // A new conversation takes the replacement, not a cold start.
      const other = done(await fast.ask('hello', 'two'));
      assert.equal(pidOf(other.text), fast.starts()[1]!.pid);
      assert.equal(await fast.workerCount(), 3);
    } finally {
      await fast.dispose();
    }
  });

  it('a request with nothing warm starts a worker cold', async () => {
    const fast = harness();
    try {
      const last = done(await fast.ask('hello'));
      assert.equal(pidOf(last.text), fast.starts()[0]!.pid);
      assert.match(last.text, /turn=1$/);
    } finally {
      await fast.dispose();
    }
  });

  it('kills the idle warm worker once the keep-warm window has passed', async () => {
    const fast = harness({ settings: { keepWarmMs: 300 } });
    try {
      await fast.prewarm();
      assert.equal(await fast.workerCount(), 1);
      await until(async () => (await fast.workerCount()) === 0, 3000);
    } finally {
      await fast.dispose();
    }
  });

  it('starts no replacement outside the keep-warm window', async () => {
    const fast = harness({ settings: { keepWarmMs: 0 } });
    try {
      await fast.ask('hello');
      assert.equal(await fast.workerCount(), 1, 'only the session worker');
    } finally {
      await fast.dispose();
    }
  });

  it('keeps a conversation on one worker, and conversations apart', async () => {
    const fast = harness();
    try {
      const first = done(await fast.ask('hello', 'a')).text;
      const second = done(await fast.ask('now make it recursive', 'a')).text;
      assert.equal(pidOf(second), pidOf(first));
      assert.match(second, /turn=2$/);

      const other = done(await fast.ask('hello', 'b')).text;
      assert.notEqual(pidOf(other), pidOf(first));
      assert.match(other, /turn=1$/, 'a new key never sees another conversation');
    } finally {
      await fast.dispose();
    }
  });

  it('end() kills the conversation and the next request starts fresh', async () => {
    const fast = harness({ settings: { keepWarmMs: 0 } });
    try {
      const pid = pidOf(done(await fast.ask('hello', 'a')).text);
      await fast.end('a');
      await until(() => !isRunning(pid));
      assert.equal(await fast.workerCount(), 0);
      assert.match(done(await fast.ask('hello', 'a')).text, /turn=1$/);
    } finally {
      await fast.dispose();
    }
  });

  it("a conversation's worker dies after the session idle time", async () => {
    const fast = harness({ settings: { keepWarmMs: 0, sessionIdleMs: 300 } });
    try {
      const pid = pidOf(done(await fast.ask('hello', 'a')).text);
      await until(() => !isRunning(pid), 3000);
      await until(async () => (await fast.workerCount()) === 0);
    } finally {
      await fast.dispose();
    }
  });

  it('stopping the stream interrupts the turn, and the conversation goes on', async () => {
    const fast = harness();
    try {
      const started = performance.now();
      const first = await fast.run(FastService.use((service) =>
        Stream.runCollect(service.request({ agentId: 'claude', sessionKey: 'a', input: input('slow') }).pipe(Stream.take(3)))));
      assert.equal(first.length, 3);
      assert.ok(performance.now() - started < 2000, 'stopped well before the slow reply would end');
      await until(() => fast.events().some((event) => event.event === 'interrupt'));

      const next = done(await fast.ask('hello', 'a')).text;
      assert.match(next, /turn=2$/, 'same worker, after the interrupted turn');
      assert.equal(fast.events().filter((event) => event.event === 'start').length, 2, 'session worker plus the warm one');
    } finally {
      await fast.dispose();
    }
  });

  it('interrupting the fiber stops the request at once', async () => {
    const fast = harness();
    try {
      const fiber = fast.runtime.runFork(FastService.use((service) =>
        Stream.runDrain(service.request({ agentId: 'claude', sessionKey: 'a', input: input('slow') }))));
      await until(() => fast.events().some((event) => event.event === 'request'));
      await new Promise((resolve) => setTimeout(resolve, 100));
      const started = performance.now();
      await Effect.runPromise(Fiber.interrupt(fiber));
      assert.ok(performance.now() - started < 200);
      await until(() => fast.events().some((event) => event.event === 'interrupt'));
      assert.match(done(await fast.ask('hello', 'a')).text, /turn=2$/);
    } finally {
      await fast.dispose();
    }
  });

  it('a crash fails the request with the reason, and the next request works', async () => {
    const fast = harness();
    try {
      const error = failure(await fast.askExit('crash', 'a'));
      assert.equal(error._tag, 'AgentFailed');
      assert.match(error.reason, /^Claude Code stopped unexpectedly \(exit code 3\): Error: something broke/);
      assert.match(done(await fast.ask('hello', 'a')).text, /turn=1$/);
    } finally {
      await fast.dispose();
    }
  });

  it('a worker that stops answering times out, and the pool recovers', async () => {
    const fast = harness({ settings: { noOutputTimeoutMs: 300 } });
    try {
      const started = performance.now();
      const error = failure(await fast.askExit('hang', 'a'));
      assert.equal(error._tag, 'AgentFailed');
      assert.match(error.reason, /didn't answer within/);
      assert.ok(performance.now() - started < 2000);
      assert.match(done(await fast.ask('hello', 'a')).text, /turn=1$/);
    } finally {
      await fast.dispose();
    }
  });

  it('reports a signed-out CLI as unavailable, with what to do', async () => {
    const fast = harness();
    try {
      const error = failure(await fast.askExit('auth'));
      assert.equal(error._tag, 'AgentUnavailable');
      assert.equal(error.reason, SIGNED_OUT);
    } finally {
      await fast.dispose();
    }
  });

  it('reports an API error as a short failure', async () => {
    const fast = harness();
    try {
      const error = failure(await fast.askExit('api-error'));
      assert.equal(error._tag, 'AgentFailed');
      assert.match(error.reason, /^Claude Code failed: API Error: 529/);
    } finally {
      await fast.dispose();
    }
  });

  it('reports a missing CLI as not installed, and prewarm stays quiet', async () => {
    const empty = mkdtempSync(join(scratch, 'empty-'));
    const fast = harness({ settings: { claudeExecutable: null }, env: { PATH: empty, HOME: empty } });
    try {
      await fast.prewarm();
      assert.equal(await fast.workerCount(), 0);
      const error = failure(await fast.askExit('hello'));
      assert.deepEqual([error._tag, error.reason], ['AgentUnavailable', NOT_INSTALLED]);
    } finally {
      await fast.dispose();
    }
  });

  it('has no fast mode for other agents yet', async () => {
    const fast = harness({ config: { agents: { mine: { name: 'My Agent', command: 'mine' } } } });
    try {
      assert.equal(failure(await fast.askExit('hello', 'a', 'opencode')).reason, "Fast mode isn't available for OpenCode yet.");
      assert.equal(failure(await fast.askExit('hello', 'a', 'mine')).reason, "Fast mode isn't available for My Agent yet.");
      await fast.prewarm('opencode');
      assert.equal(await fast.workerCount(), 0);
    } finally {
      await fast.dispose();
    }
  });

  it('drains a chatty stderr', async () => {
    const fast = harness({ env: { FAKE_CLAUDE_STDERR_SPAM: '1' } });
    try {
      assert.equal(done(await fast.ask('reply: ls')).text, 'ls');
    } finally {
      await fast.dispose();
    }
  });

  it("kills the worker's whole process group", async () => {
    const fast = harness({ env: { FAKE_CLAUDE_GRANDCHILD: '1' } });
    try {
      await fast.ask('hello');
      assert.ok(fast.starts().every((start) => start.grandchild && isRunning(start.grandchild)));
    } finally {
      await fast.dispose();
    }
  });
});

