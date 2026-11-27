import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as Layer from 'effect/Layer';
import * as ManagedRuntime from 'effect/ManagedRuntime';
import * as Stream from 'effect/Stream';
import { type FakeOpenCode, startFakeOpenCode } from '../../../test/fixtures/fake-opencode-server.js';
import type { FastEvent, FastInput } from '../../protocol/schema.js';
import { type ConfigFile, FastService, ShellyConfig } from '../services.js';
import * as Fast from './fast-service.js';
import { OpenCodeConnection, type OpenCodeEvent, SERVICE_REJECTED } from './opencode-server.js';
import { AGENT_ID, NOT_INSTALLED, SIGNED_OUT } from './opencode-worker.js';
import { FAST_SYSTEM_PROMPT } from './prompt.js';

const FAKE_OPENCODE = fileURLToPath(new URL('../../../test/fixtures/fake-opencode.mjs', import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'shelly-fast-opencode-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

let harnessCount = 0;

const writeState = (stateHome: string, url: string, password: string) => {
  mkdirSync(join(stateHome, 'opencode'), { recursive: true });
  writeFileSync(join(stateHome, 'opencode', 'service.json'), JSON.stringify({ id: 'x', version: '2.4.1', url, pid: process.pid, password }));
};

/** A FastService whose OpenCode is the fake service; `running: false` leaves it to `opencode service start`. */
const harness = async (options: {
  readonly settings?: Partial<Fast.FastSettingsValue>;
  readonly config?: ConfigFile;
  readonly running?: boolean;
  readonly statePassword?: string;
} = {}) => {
  const fake = await startFakeOpenCode();
  const dir = join(scratch, `h${++harnessCount}`);
  const stateHome = join(dir, 'state');
  const log = join(dir, 'opencode.log');
  mkdirSync(dir, { recursive: true });
  if (options.running !== false) writeState(stateHome, fake.url, options.statePassword ?? fake.password);
  const settings: Fast.FastSettingsValue = {
    fastHome: join(dir, 'fast'),
    keepWarmMs: 60_000,
    sessionIdleMs: 60_000,
    maxSessions: 10,
    noOutputTimeoutMs: 5000,
    claudeExecutable: '/nonexistent/claude',
    opencodeExecutable: FAKE_OPENCODE,
    opencodeConnectionGraceMs: 0,
    env: {
      PATH: process.env.PATH,
      HOME: dir,
      XDG_STATE_HOME: stateHome,
      FAKE_OPENCODE_LOG: log,
      FAKE_OPENCODE_URL: fake.url,
      FAKE_OPENCODE_PASSWORD: options.statePassword ?? fake.password,
    },
    ...options.settings,
  };
  const runtime = ManagedRuntime.make(Fast.layer.pipe(Layer.provide(Layer.merge(
    Layer.succeed(ShellyConfig, ShellyConfig.of({ get: Effect.succeed(options.config ?? {}), setDefaultAgent: () => Effect.void })),
    Layer.succeed(Fast.FastSettings, settings),
  ))));

  const run = <A, E>(effect: Effect.Effect<A, E, FastService>) => runtime.runPromise(effect);
  const collect = (instruction: string, sessionKey: string, limit = Infinity) =>
    FastService.use((fast) =>
      Stream.runCollect(fast.request({ agentId: 'opencode', sessionKey, input: input(instruction) }).pipe(Stream.take(limit))));
  const ask = (instruction: string, sessionKey = 'one') => run(collect(instruction, sessionKey));
  const askExit = (instruction: string, sessionKey = 'one') => runtime.runPromiseExit(collect(instruction, sessionKey));
  const workerCount = () => run(FastService.use((fast) => fast.workerCount));
  const prewarm = () => run(FastService.use((fast) => fast.prewarm('opencode')));
  const end = (sessionKey: string) => run(FastService.use((fast) => fast.end(sessionKey)));
  const posts = (suffix: string) => fake.requests.filter((r) => r.method === 'POST' && r.path.endsWith(suffix));
  const cliCalls = (): string[][] => {
    try {
      return readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as string[]);
    } catch {
      return [];
    }
  };

  /** Dispose, and check that every session was deleted and the event stream closed. */
  const dispose = async (servers: FakeOpenCode[] = [fake]) => {
    await runtime.dispose();
    try {
      for (const server of servers) {
        await until(() => server.streams() === 0);
        const left = [...server.sessions.values()].filter((s) => s.directory === join(settings.fastHome, 'opencode'));
        assert.equal(left.length, 0, 'fast sessions outlived the service');
      }
    } finally {
      for (const server of servers) await server.close();
    }
  };

  return { fake, run, ask, askExit, collect, workerCount, prewarm, end, posts, cliCalls, dispose, settings, stateHome, runtime };
};

const input = (instruction: string): FastInput => ({
  instruction,
  buffer: '',
  cwd: '/tmp/project',
  environment: { os: 'macOS 25.0.0 (arm64)', shell: 'zsh', shellVersion: null, terminal: null },
  recentCommands: [],
});

/** The fake answers what is in <request>, so tests can script it. */
const requestText = (body: unknown) => /<request>([\s\S]*)<\/request>/.exec((body as { text: string }).text)?.[1];

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

const sessionOf = (text: string) => /session=(\S+)/.exec(text)?.[1];

describe('FastService on OpenCode', () => {
  it('streams deltas, then one done with the cleaned command', async () => {
    const fast = await harness();
    try {
      const events = await fast.ask('reply: ```bash\n$ ls -la\n```');
      const deltas = events.filter((event) => event.type === 'delta');
      assert.ok(deltas.length >= 2, 'expected several deltas');
      assert.equal(deltas.map((event) => event.text).join(''), '```bash\n$ ls -la\n```', 'reasoning is left out');
      const last = done(events);
      assert.deepEqual([last.kind, last.text], ['command', 'ls -la']);
      assert.equal(events.filter((event) => event.type === 'done').length, 1);
    } finally {
      await fast.dispose();
    }
  });

  it("runs Shelly's no-tools agent in Shelly's folder, with the model from the config", async () => {
    const fast = await harness({ config: { agents: { opencode: { fastModel: 'opencode/some/model-free' } } } });
    try {
      await fast.ask('hello');
      const cwd = join(fast.settings.fastHome, 'opencode');
      const [create] = fast.posts('/api/session');
      assert.deepEqual(create?.body, {
        agent: AGENT_ID,
        model: { providerID: 'opencode', id: 'some/model-free' },
        location: { directory: cwd },
        permissions: [{ action: '*', resource: '*', effect: 'deny' }],
      });
      const config = JSON.parse(readFileSync(join(cwd, 'opencode.json'), 'utf8'));
      assert.equal(config.agent[AGENT_ID].prompt, FAST_SYSTEM_PROMPT);
      assert.deepEqual(config.agent[AGENT_ID].permission, { '*': 'deny' });
      assert.deepEqual(config.agent.title, { disable: true }, 'no title generation before the reply');
      const [prompt] = fast.posts('/prompt');
      assert.equal(requestText(prompt?.body), 'hello');
      assert.match((prompt?.body as { text: string }).text, /<shell>zsh<\/shell>/);
    } finally {
      await fast.dispose();
    }
  });

  it('defaults to a fast model, and refuses one without a provider', async () => {
    const fast = await harness();
    try {
      await fast.ask('hello');
      assert.deepEqual((fast.posts('/api/session')[0]?.body as { model: unknown }).model, { providerID: 'opencode-go', id: 'claude-haiku-5-5' });
    } finally {
      await fast.dispose();
    }
    const bad = await harness({ config: { agents: { opencode: { fastModel: 'haiku' } } } });
    try {
      const error = failure(await bad.askExit('hello'));
      assert.equal(error._tag, 'AgentUnavailable');
      assert.match(error.reason, /provider\/model/);
    } finally {
      await bad.dispose();
    }
  });

  it('prewarm makes one session at once, and a request takes it and makes the next', async () => {
    const fast = await harness();
    try {
      const started = performance.now();
      await fast.prewarm();
      await fast.prewarm();
      assert.ok(performance.now() - started < 200, 'prewarm should not wait');
      await until(() => fast.fake.sessions.size === 1);
      const [warm] = fast.fake.sessions.keys();
      assert.equal(await fast.workerCount(), 1);

      const last = done(await fast.ask('hello'));
      assert.equal(sessionOf(last.text), warm);
      await until(() => fast.fake.sessions.size === 2);
      assert.equal(await fast.workerCount(), 2, 'the conversation and a new warm session');
      assert.equal(fast.fake.streams(), 1, 'one event stream for every session');
    } finally {
      await fast.dispose();
    }
  });

  it('keeps a conversation in one session, and conversations apart', async () => {
    const fast = await harness();
    try {
      const first = done(await fast.ask('hello', 'a')).text;
      const second = done(await fast.ask('now make it recursive', 'a')).text;
      assert.equal(sessionOf(second), sessionOf(first));
      assert.match(second, /turn=2$/);
      const other = done(await fast.ask('hello', 'b')).text;
      assert.notEqual(sessionOf(other), sessionOf(first));
      assert.match(other, /turn=1$/);
    } finally {
      await fast.dispose();
    }
  });

  it('end() deletes the session, and the event stream closes with the last one', async () => {
    const fast = await harness({ settings: { keepWarmMs: 0 } });
    try {
      const id = sessionOf(done(await fast.ask('hello', 'a')).text)!;
      await fast.end('a');
      await until(() => !fast.fake.sessions.has(id));
      await until(async () => (await fast.workerCount()) === 0);
      await until(() => fast.fake.streams() === 0);
      assert.match(done(await fast.ask('hello', 'a')).text, /turn=1$/, 'a fresh session');
    } finally {
      await fast.dispose();
    }
  });

  it('stopping the stream interrupts the turn and drops its session; the next request takes the warm one', async () => {
    const fast = await harness();
    try {
      const started = performance.now();
      const first = await fast.run(fast.collect('slow', 'a', 3));
      assert.equal(first.length, 3);
      assert.ok(performance.now() - started < 2000);
      await until(() => fast.posts('/interrupt').length >= 1);
      assert.equal(fast.posts('/api/session').length, 2, "the request's session and a warm one");
      // The cancelled turn would stay in the conversation: that session goes.
      await until(() => fast.fake.sessions.size === 1);
      const next = done(await fast.ask('hello', 'a')).text;
      assert.match(next, /turn=1$/, 'a fresh conversation, without the cancelled turn');
      assert.equal(fast.posts('/api/session').length, 3, 'it took the warm session, and a new warm one was made');
    } finally {
      await fast.dispose();
    }
  });

  it('a request that replaces a running one starts a fresh session', async () => {
    const fast = await harness();
    try {
      const running = fast.askExit('slow', 'a');
      await until(() => fast.posts('/prompt').length === 1);
      const next = done(await fast.ask('hello', 'a')).text;
      assert.match(next, /turn=1$/);
      assert.ok(Exit.isFailure(await running), 'the replaced request fails');
    } finally {
      await fast.dispose();
    }
  });

  it('a session that stops answering times out, and the next request gets a new one', async () => {
    const fast = await harness({ settings: { noOutputTimeoutMs: 300 } });
    try {
      const error = failure(await fast.askExit('hang', 'a'));
      assert.equal(error._tag, 'AgentFailed');
      assert.match(error.reason, /^OpenCode didn't answer within/);
      assert.match(done(await fast.ask('hello', 'a')).text, /turn=1$/);
    } finally {
      await fast.dispose();
    }
  });

  it("reports a model OpenCode can't reach as unavailable, with what to do", async () => {
    const fast = await harness();
    try {
      const noRoute = failure(await fast.askExit('no-route'));
      assert.equal(noRoute._tag, 'AgentUnavailable');
      assert.match(noRoute.reason, /^OpenCode can't use opencode-go\/claude-haiku-5-5 for fast mode \(Model unavailable: nosuch\/model\)\. Sign in with `opencode auth login`, or set agents\.opencode\.fastModel/);
      const auth = failure(await fast.askExit('auth', 'b'));
      assert.deepEqual([auth._tag, auth.reason], ['AgentUnavailable', SIGNED_OUT]);
    } finally {
      await fast.dispose();
    }
  });

  it('reports a provider error as a short failure', async () => {
    const fast = await harness();
    try {
      const error = failure(await fast.askExit('error'));
      assert.deepEqual([error._tag, error.reason], ['AgentFailed', 'OpenCode failed: Upstream exploded']);
      assert.match(done(await fast.ask('hello')).text, /turn=2$/, 'the session survives a failed turn');
    } finally {
      await fast.dispose();
    }
  });

  it('refuses a permission request', async () => {
    const fast = await harness();
    try {
      assert.match(done(await fast.ask('permission')).text, /turn=1$/);
      const [reply] = fast.posts('/permission/per_1/reply');
      assert.deepEqual(reply?.body, { decision: 'reject', message: 'Fast mode has no tools.' });
    } finally {
      await fast.dispose();
    }
  });

  it('a lost service fails the request, and the next one reconnects', async () => {
    const fast = await harness();
    const second = await startFakeOpenCode();
    try {
      const error = failure(await fast.askExit('crash', 'a'));
      assert.equal(error._tag, 'AgentFailed');
      assert.match(error.reason, /^OpenCode stopped unexpectedly/);
      // OpenCode came back (restarted, say) at another address.
      writeState(fast.stateHome, second.url, second.password);
      const text = done(await fast.ask('hello', 'a')).text;
      assert.match(text, /turn=1$/);
      assert.ok(second.sessions.has(sessionOf(text)!));
    } finally {
      await fast.dispose([second]);
      await fast.fake.close();
    }
  });

  it('starts the background service when it is stopped', async () => {
    const fast = await harness({ running: false });
    try {
      assert.match(done(await fast.ask('hello')).text, /turn=1$/);
      assert.deepEqual(fast.cliCalls(), [['service', 'start']]);
    } finally {
      await fast.dispose();
    }
  });

  it('reports a service that rejects the password', async () => {
    const fast = await harness({ statePassword: 'wrong' });
    try {
      const error = failure(await fast.askExit('hello'));
      assert.deepEqual([error._tag, error.reason], ['AgentFailed', SERVICE_REJECTED]);
    } finally {
      await fast.dispose();
    }
  });

  it('reports a missing CLI as not installed, and prewarm stays quiet', async () => {
    const empty = mkdtempSync(join(scratch, 'empty-'));
    const fast = await harness({ settings: { opencodeExecutable: null, env: { PATH: empty, HOME: empty } } });
    try {
      await fast.prewarm();
      assert.equal(await fast.workerCount(), 0);
      const error = failure(await fast.askExit('hello'));
      assert.deepEqual([error._tag, error.reason], ['AgentUnavailable', NOT_INSTALLED]);
      assert.equal(fast.fake.requests.length, 0);
    } finally {
      await fast.dispose();
    }
  });

  it('deletes sessions an earlier daemon left in its folder, and nothing else', async () => {
    const fast = await harness();
    try {
      const cwd = join(fast.settings.fastHome, 'opencode');
      const leftover = fast.fake.addLeftover(cwd);
      const users = fast.fake.addLeftover('/Users/someone/project');
      // Made after the connection opened, as this daemon's own session is before its id is known.
      const fresh = fast.fake.addLeftover(cwd, Date.now() + 60_000);
      await fast.ask('hello');
      await until(() => !fast.fake.sessions.has(leftover));
      assert.ok(fast.fake.sessions.has(users));
      assert.ok(fast.fake.sessions.has(fresh), 'a session newer than the connection is never swept');
      fast.fake.sessions.delete(users);
      fast.fake.sessions.delete(fresh);
    } finally {
      await fast.dispose();
    }
  });

  it('keeps the connection for a grace period after the last session, so sessions that come and go share it', async () => {
    const fast = await harness({ settings: { keepWarmMs: 0, opencodeConnectionGraceMs: 400 } });
    try {
      await fast.ask('hello', 'a');
      await fast.end('a');
      await until(() => fast.fake.sessions.size === 0);
      assert.equal(fast.fake.streams(), 1, 'still open within the grace period');
      await fast.ask('hello', 'b');
      await fast.end('b');
      assert.equal(fast.fake.requests.filter((r) => r.path === '/api/event').length, 1, 'one connection for both');
      await until(() => fast.fake.streams() === 0, 5000);
    } finally {
      await fast.dispose();
    }
  });
});

describe('OpenCodeConnection', () => {
  it('keeps the event stream open well past the subscribe timeout', async () => {
    const fake = await startFakeOpenCode({ heartbeatMs: 50 });
    const connection = await OpenCodeConnection.open({ url: fake.url, password: fake.password }, { subscribeTimeoutMs: 200 });
    try {
      await new Promise((resolve) => setTimeout(resolve, 800));
      assert.equal(connection.closed, false);
      const created = await connection.request<{ data: { id: string } }>('POST', '/api/session', { location: { directory: '/x' } });
      const events: OpenCodeEvent[] = [];
      connection.listen(created.data.id, (event) => events.push(event));
      await connection.request('POST', `/api/session/${created.data.id}/prompt`, { text: 'reply: ls' });
      await until(() => events.some((event) => event.type === 'session.execution.succeeded'));
      assert.equal(fake.streams(), 1);
      assert.equal(fake.requests.filter((r) => r.path === '/api/event').length, 1, 'never reconnected');
    } finally {
      connection.close();
      await fake.close();
    }
  });

  it('gives up on a service that never answers the subscription', async () => {
    const { createServer } = await import('node:http');
    const server = createServer(() => {}); // accepts, never responds
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as { port: number };
    try {
      const started = performance.now();
      await assert.rejects(OpenCodeConnection.open({ url: `http://127.0.0.1:${port}`, password: 'x' }, { subscribeTimeoutMs: 200 }));
      assert.ok(performance.now() - started < 2000);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
