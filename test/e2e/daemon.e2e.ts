import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { after, afterEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { DaemonClient, DaemonDisconnected, type DaemonClientOptions } from '../../src/client/daemon-client.js';
import { isProcessAlive, readLock } from '../../src/daemon/lock.js';
import { shellyPaths } from '../../src/protocol/paths.js';
import { probeSocket } from '../../src/protocol/probe.js';
import type { PromptContext, ThreadEvent } from '../../src/protocol/schema.js';

/*
 * The daemon as a real process on a real socket, started by the client the
 * way a terminal starts it, with fake agents (SHELLY_DAEMON_TEST_RUNTIME).
 * Every daemon a test starts is stopped before the file ends.
 */

const ENTRY = fileURLToPath(new URL('../../src/index.ts', import.meta.url));
const FAKE_RUNTIME = fileURLToPath(new URL('./fake-runtime.ts', import.meta.url));
const TSX = import.meta.resolve('tsx');
// As the shelly script runs it: --experimental-ffi gives the daemon its flock lock.
const EXEC_ARGV = ['--experimental-ffi', '--no-warnings', '--import', TSX];
// tsx compiles on the fly, so a spawned daemon is slower to answer here than when built.
const START_TIMEOUT_MS = 15_000;

const CONTEXT: PromptContext = {
  cwd: '/work/app',
  environment: { os: 'TestOS', shell: 'zsh', shellVersion: null, terminal: null },
  commands: [{ id: 1, command: 'make', cwd: '/work/app', exitCode: 2, durationMs: 1500, output: 'error: nope', omittedLines: 0, usedFullScreen: false }],
};

const homes: string[] = [];
const daemonPids = new Set<number>();
const clients: DaemonClient[] = [];

/** Short, since a socket path must fit in 104 bytes. */
const newHome = (): string => {
  const home = mkdtempSync(join(tmpdir(), 'shd-'));
  homes.push(home);
  return home;
};

const daemonEnv = (home: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  ...process.env,
  SHELLY_HOME: home,
  SHELLY_DAEMON_TEST_RUNTIME: FAKE_RUNTIME,
  ...extra,
});

const newClient = (home: string, options: Partial<DaemonClientOptions> & { extraEnv?: Record<string, string> } = {}): DaemonClient => {
  const client = new DaemonClient({
    env: daemonEnv(home, options.extraEnv),
    entry: ENTRY,
    execArgv: EXEC_ARGV,
    startTimeoutMs: START_TIMEOUT_MS,
    ...options,
  });
  clients.push(client);
  return client;
};

const connect = async (client: DaemonClient) => {
  const hello = await client.connect();
  daemonPids.add(hello.pid);
  return hello;
};

/** Run `shelly daemon` in the foreground, as a child this test owns. */
const runDaemonProcess = (home: string, extra: Record<string, string> = {}) => {
  const child = spawn(process.execPath, [...EXEC_ARGV, ENTRY, 'daemon'], {
    env: daemonEnv(home, extra),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => (output += chunk));
  child.stderr.on('data', (chunk) => (output += chunk));
  if (child.pid) {
    daemonPids.add(child.pid);
  }
  const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
  return { child, exited, output: () => output };
};

const waitFor = async (check: () => boolean | Promise<boolean>, what: string, timeoutMs = START_TIMEOUT_MS): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) {
      return;
    }
    await sleep(20);
  }
  assert.fail(`timed out waiting for ${what}`);
};

const collect = async (events: AsyncIterable<ThreadEvent>): Promise<ThreadEvent[]> => {
  const out: ThreadEvent[] = [];
  for await (const event of events) {
    out.push(event);
  }
  return out;
};

const types = (events: readonly ThreadEvent[]) => events.map((event) => event.type);

const stopDaemon = async (pid: number): Promise<void> => {
  if (!isProcessAlive(pid)) {
    return;
  }
  process.kill(pid, 'SIGTERM');
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && isProcessAlive(pid)) {
    await sleep(20);
  }
  if (isProcessAlive(pid)) {
    process.kill(pid, 'SIGKILL');
  }
};

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.dispose().catch(() => {})));
  await Promise.all([...daemonPids].map(stopDaemon));
  daemonPids.clear();
});

after(() => {
  for (const home of homes) {
    rmSync(home, { recursive: true, force: true });
  }
});

describe('daemon over its socket', () => {
  it('starts on first use and runs a turn end to end', async () => {
    const home = newHome();
    const paths = shellyPaths({ SHELLY_HOME: home });
    const client = newClient(home);

    const hello = await connect(client);
    assert.equal(hello.daemonVersion, '0.1.0');
    assert.equal(statSync(paths.runDir).mode & 0o777, 0o700);
    assert.equal(statSync(paths.socket).mode & 0o777, 0o600);
    assert.equal(JSON.parse(readFileSync(paths.lock, 'utf8')).pid, hello.pid);
    assert.match(readFileSync(join(paths.threadHome, 'AGENTS.md'), 'utf8'), /through Shelly/);

    assert.deepEqual((await client.listAgents()).map((agent) => agent.id), ['fake', 'broken']);
    const thread = await client.createThread({ location: 'home', cwd: '/work/app' });
    assert.equal(thread.cwd, paths.threadHome);
    await client.attachThread(thread.id);

    const events = await collect(client.prompt(thread.id, 'hello daemon', CONTEXT));
    assert.deepEqual(types(events), ['turn.started', 'mode.changed', 'message.chunk', 'message.chunk', 'turn.ended']);
    const text = events.flatMap((event) => (event.type === 'message.chunk' ? [event.text] : [])).join('');
    assert.equal(text, 'echo: hello daemon');

    // History comes back compacted on attach, and through watch.
    const { thread: attached, history } = await client.attachThread(thread.id, { historyTurns: 5 });
    assert.equal(attached.title, 'hello daemon');
    assert.equal(attached.turnCount, 1);
    assert.deepEqual(types(history), ['turn.started', 'mode.changed', 'message.chunk', 'turn.ended']);
    assert.deepEqual(types(await collect(client.watch(thread.id, 0))), types(history));

    const fast: unknown[] = [];
    for await (const event of client.fastRequest({ sessionKey: 's1', input: { instruction: 'list files', buffer: '', cwd: '/', environment: CONTEXT.environment, recentCommands: [] } })) {
      fast.push(event);
    }
    assert.deepEqual(fast.at(-1), { type: 'done', text: 'ls -la', kind: 'command', durationMs: 1 });

    const status = await client.status();
    assert.equal(status.pid, hello.pid);
    assert.equal(status.clients, 1);
    assert.equal(status.runningTurns, 0);

    // The log has ids and stop reasons, never what was said.
    const log = readFileSync(paths.daemonLog, 'utf8');
    assert.match(log, /turn ended thread=\S+ turn=\S+ stopReason=end_turn/);
    assert.doesNotMatch(log, /hello daemon|error: nope/);

    assert.equal(await client.shutdown(false), true);
    await waitFor(() => !isProcessAlive(hello.pid), 'the daemon to exit');
    assert.equal(existsSync(paths.socket), false);
    // An flock'd lock file is never removed (that would reopen the race); it is emptied.
    assert.equal(readLock(paths.lock), undefined);
  });

  it('keeps a turn going after its stream is dropped, and answers permissions', async () => {
    const home = newHome();
    const client = newClient(home);
    await connect(client);
    const thread = await client.createThread({ location: 'folder', cwd: '/work/app' });
    await client.attachThread(thread.id);

    let requestId = '';
    for await (const event of client.prompt(thread.id, 'ask permission first', CONTEXT)) {
      if (event.type === 'permission.requested') {
        requestId = event.requestId;
        break;
      }
    }
    assert.equal(requestId, 'perm-1');
    const [waiting] = await client.listThreads();
    assert.equal(waiting?.status, 'waiting');
    assert.equal((await client.status()).runningTurns, 1);

    // Another terminal can watch but not answer.
    const other = newClient(home);
    const watching = collect(other.watch(thread.id, 0));
    await assert.rejects(other.respond(thread.id, requestId, 'allow'), { _tag: 'ThreadBusy' });
    await assert.rejects(collect(other.prompt(thread.id, 'me too', CONTEXT)), { _tag: 'ThreadBusy' });

    await client.respond(thread.id, requestId, 'allow');
    const watched = await watching;
    assert.deepEqual(types(watched), [
      'turn.started',
      'mode.changed',
      'message.chunk',
      'permission.requested',
      'permission.resolved',
      'message.chunk',
      'turn.ended',
    ]);
    assert.equal((await client.listThreads())[0]?.status, 'idle');
  });

  it('releases a terminal\'s threads when it disconnects', async () => {
    const home = newHome();
    const first = newClient(home);
    await connect(first);
    const thread = await first.createThread({ location: 'home', cwd: '/work' });
    await first.attachThread(thread.id);
    const second = newClient(home);
    await assert.rejects(second.attachThread(thread.id), { _tag: 'ThreadBusy' });
    await first.close();
    await waitFor(async () => (await second.listThreads())[0]?.attachedBy === null, 'the attachment to be released', 3000);
    await second.attachThread(thread.id);
  });
});

describe('daemon lifecycle', () => {
  it('lets only one daemon run', async () => {
    const home = newHome();
    const client = newClient(home);
    const hello = await connect(client);
    const second = runDaemonProcess(home);
    assert.equal(await second.exited, 0);
    assert.match(second.output(), new RegExp(`another daemon is running \\(pid ${hello.pid}\\)`));
    assert.equal((await client.status()).pid, hello.pid);
  });

  for (const mechanism of ['flock', 'file'] as const) {
    it(`lets exactly one of several daemons racing for a stale lock survive (${mechanism})`, async () => {
      const home = newHome();
      const paths = shellyPaths({ SHELLY_HOME: home });
      mkdirSync(paths.runDir, { recursive: true, mode: 0o700 });
      const gone = spawn(process.execPath, ['-e', '']);
      await new Promise((resolve) => gone.once('exit', resolve));
      writeFileSync(paths.lock, JSON.stringify({ pid: gone.pid, startedAt: Date.now() - 60_000, mechanism }));

      // Several windows restored at once: every daemon reaches for the lock at the same instant.
      const lockAt = String(Date.now() + 3000);
      const extra = { SHELLY_DAEMON_TEST_LOCK_AT: lockAt, ...(mechanism === 'file' ? { SHELLY_DAEMON_LOCK: 'file' } : {}) };
      const daemons = Array.from({ length: 4 }, () => runDaemonProcess(home, extra));
      await waitFor(() => probeSocket(paths.socket), 'a daemon to listen');
      await waitFor(() => daemons.filter(({ child }) => child.exitCode === null).length <= 1, 'all but one daemon to exit');
      const survivors = daemons.filter(({ child }) => child.exitCode === null);
      assert.equal(survivors.length, 1, 'exactly one daemon survives');
      for (const daemon of daemons.filter((candidate) => candidate !== survivors[0])) {
        assert.equal(daemon.child.exitCode, 0);
        assert.match(daemon.output(), /another daemon is running/);
      }
      const client = newClient(home, { autoStart: false });
      assert.equal((await connect(client)).pid, survivors[0]?.child.pid);
      const lock = JSON.parse(readFileSync(paths.lock, 'utf8'));
      assert.equal(lock.pid, survivors[0]?.child.pid);
      assert.equal(lock.mechanism, mechanism);
    });

    it(`lets a new daemon start at once after one is killed holding the lock (${mechanism})`, async () => {
      const home = newHome();
      const paths = shellyPaths({ SHELLY_HOME: home });
      const extra: Record<string, string> = mechanism === 'file' ? { SHELLY_DAEMON_LOCK: 'file' } : {};
      const first = runDaemonProcess(home, extra);
      await waitFor(() => probeSocket(paths.socket), 'the first daemon to listen');
      first.child.kill('SIGKILL');
      await first.exited;
      // It left its socket file and its lock file behind.
      assert.ok(existsSync(paths.socket));
      assert.equal(JSON.parse(readFileSync(paths.lock, 'utf8')).pid, first.child.pid);

      const second = runDaemonProcess(home, extra);
      await waitFor(() => probeSocket(paths.socket), 'the second daemon to listen');
      assert.equal(second.child.exitCode, null);
      const client = newClient(home, { autoStart: false });
      assert.equal((await connect(client)).pid, second.child.pid);
      assert.equal(JSON.parse(readFileSync(paths.lock, 'utf8')).pid, second.child.pid);
    });
  }

  it('starts a new daemon for a client that arrives while the old one is still stopping', async () => {
    const home = newHome();
    const paths = shellyPaths({ SHELLY_HOME: home });
    const old = runDaemonProcess(home);
    await waitFor(() => probeSocket(paths.socket), 'the daemon to listen');
    const driver = newClient(home, { autoStart: false });
    await connect(driver);
    const thread = await driver.createThread({ location: 'home', cwd: '/work' });
    await driver.attachThread(thread.id);
    const seen: ThreadEvent[] = [];
    const running = (async () => {
      for await (const event of driver.prompt(thread.id, 'wait, and ignore cancel', CONTEXT)) {
        seen.push(event);
      }
    })().catch(() => {});
    await waitFor(() => seen.some((event) => event.type === 'message.chunk'), 'the turn to start');

    // The old daemon closes its socket at once, then gives the stuck turn
    // 2 s while it still holds the lock.
    assert.equal(await driver.shutdown(false), true);
    await waitFor(async () => !(await probeSocket(paths.socket)), 'the old daemon to close its socket');
    assert.equal(old.child.exitCode, null, 'the old daemon is still stopping');

    const client = newClient(home);
    const hello = await connect(client);
    assert.notEqual(hello.pid, old.child.pid);
    assert.equal(await old.exited, 0);
    assert.equal((await client.listThreads())[0]?.id, thread.id);
    await running;
  });

  for (const mechanism of ['flock', 'file'] as const) {
    it(`starts when the lock names a live process that is not a daemon, a reused pid (${mechanism})`, async () => {
      const home = newHome();
      const paths = shellyPaths({ SHELLY_HOME: home });
      mkdirSync(paths.runDir, { recursive: true, mode: 0o700 });
      // An old lock from a daemon that used the file-based lock, its pid now someone else's.
      const stranger = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      try {
        writeFileSync(paths.lock, JSON.stringify({ pid: stranger.pid, startedAt: Date.now() - 60_000, mechanism: 'file' }));
        const daemon = runDaemonProcess(home, mechanism === 'file' ? { SHELLY_DAEMON_LOCK: 'file' } : {});
        await waitFor(() => probeSocket(paths.socket), 'the daemon to listen');
        assert.equal(daemon.child.exitCode, null);
        assert.equal(JSON.parse(readFileSync(paths.lock, 'utf8')).pid, daemon.child.pid);
      } finally {
        stranger.kill('SIGKILL');
      }
    });
  }

  it('takes over a stale lock and a stale socket', async () => {
    const home = newHome();
    const paths = shellyPaths({ SHELLY_HOME: home });
    mkdirSync(paths.runDir, { recursive: true, mode: 0o700 });

    // A socket file left by a process that died without cleaning up.
    const holder = spawn(process.execPath, ['-e', `require('net').createServer().listen(${JSON.stringify(paths.socket)}, () => console.log('up')); setInterval(() => {}, 1000)`], { stdio: ['ignore', 'pipe', 'ignore'] });
    await new Promise((resolve) => holder.stdout!.once('data', resolve));
    holder.kill('SIGKILL');
    await new Promise((resolve) => holder.once('exit', resolve));
    assert.ok(existsSync(paths.socket));
    assert.equal(await probeSocket(paths.socket), false);
    // A lock naming that dead process.
    writeFileSync(paths.lock, JSON.stringify({ pid: holder.pid, startedAt: Date.now() - 1000 }));

    const client = newClient(home);
    const hello = await connect(client);
    assert.notEqual(hello.pid, holder.pid);
    assert.equal(JSON.parse(readFileSync(paths.lock, 'utf8')).pid, hello.pid);
  });

  it('exits after the idle timeout with no clients', async () => {
    const home = newHome();
    const client = newClient(home, { extraEnv: { SHELLY_DAEMON_IDLE_MS: '300' } });
    const hello = await connect(client);
    await sleep(600);
    assert.ok(isProcessAlive(hello.pid), 'a connected client keeps it running');
    await client.close();
    await waitFor(() => !isProcessAlive(hello.pid), 'the idle daemon to exit', 5000);
  });

  it('ends running turns as interrupted on SIGTERM and exits 0', async () => {
    const home = newHome();
    const daemon = runDaemonProcess(home);
    const client = newClient(home, { autoStart: false });
    await waitFor(() => probeSocket(shellyPaths({ SHELLY_HOME: home }).socket), 'the daemon to listen');
    await connect(client);
    const thread = await client.createThread({ location: 'home', cwd: '/work' });
    await client.attachThread(thread.id);

    const seen: ThreadEvent[] = [];
    const running = (async () => {
      for await (const event of client.prompt(thread.id, 'wait for me', CONTEXT)) {
        seen.push(event);
      }
    })();
    await waitFor(() => seen.some((event) => event.type === 'message.chunk'), 'the turn to start');

    daemon.child.kill('SIGTERM');
    await assert.rejects(running, DaemonDisconnected);
    assert.equal(await daemon.exited, 0);

    // The next daemon finds the turn already ended as interrupted.
    const restarted = newClient(home);
    await connect(restarted);
    const events = await collect(restarted.watch(thread.id, 0));
    const ended = events.at(-1);
    assert.equal(ended?.type, 'turn.ended');
    assert.equal(ended?.type === 'turn.ended' ? ended.stopReason : null, 'interrupted');
    assert.equal((await restarted.listThreads())[0]?.status, 'idle');
  });

  it('reconnects, starting a new daemon, after the old one went away', async () => {
    const home = newHome();
    const client = newClient(home);
    const first = await connect(client);
    const thread = await client.createThread({ location: 'home', cwd: '/work' });
    await stopDaemon(first.pid);
    await waitFor(() => !isProcessAlive(first.pid), 'the daemon to stop');

    const threads = await client.listThreads();
    assert.deepEqual(threads.map((summary) => summary.id), [thread.id]);
    const second = await connect(client);
    assert.notEqual(second.pid, first.pid);
    daemonPids.add(second.pid);
  });
});

describe('daemon upgrades', () => {
  it('replaces an idle daemon older than the client, without failing the request', async () => {
    const home = newHome();
    const old = await connect(newClient(home));
    const thread = await newClient(home).createThread({ location: 'home', cwd: '/work' });

    const upgraded = newClient(home, { version: '99.0.0' });
    // The first call after the upgrade works, on a new daemon.
    assert.deepEqual((await upgraded.listThreads()).map((summary) => summary.id), [thread.id]);
    const hello = await connect(upgraded);
    assert.notEqual(hello.pid, old.pid);
    await waitFor(() => !isProcessAlive(old.pid), 'the old daemon to exit');
  });

  it('keeps using an older daemon that is running a turn', async () => {
    const home = newHome();
    const driver = newClient(home);
    const old = await connect(driver);
    const thread = await driver.createThread({ location: 'home', cwd: '/work' });
    await driver.attachThread(thread.id);
    for await (const event of driver.prompt(thread.id, 'wait for me', CONTEXT)) {
      if (event.type === 'message.chunk') {
        break;
      }
    }
    const upgraded = newClient(home, { version: '99.0.0' });
    assert.equal((await upgraded.listThreads()).length, 1);
    assert.equal((await connect(upgraded)).pid, old.pid);
    assert.equal((await upgraded.status()).runningTurns, 1, 'the turn carries on');
  });

  it('keeps an older daemon while another terminal has a fast request in flight', async () => {
    const home = newHome();
    const other = newClient(home);
    const old = await connect(other);
    const request = other.fastRequest({
      sessionKey: 's1',
      input: { instruction: 'slow one', buffer: '', cwd: '/', environment: CONTEXT.environment, recentCommands: [] },
    })[Symbol.asyncIterator]();
    assert.equal((await request.next()).value?.type, 'delta', 'the request is in flight');

    const upgraded = newClient(home, { version: '99.0.0' });
    assert.equal((await upgraded.listThreads()).length, 0);
    assert.equal((await connect(upgraded)).pid, old.pid, 'the old daemon was kept');
    assert.ok(isProcessAlive(old.pid));
    await request.return?.();

    // Once the request is over the daemon is idle, and the next client that connects replaces it.
    const later = newClient(home, { version: '99.0.0' });
    await waitFor(async () => {
      const hello = await later.connect();
      daemonPids.add(hello.pid);
      if (hello.pid === old.pid) {
        await later.close();
        return false;
      }
      return true;
    }, 'the idle daemon to be replaced', 5000);
  });

  it('replaces an older daemon another terminal is merely connected to, and that terminal carries on', async () => {
    const home = newHome();
    const other = newClient(home);
    const old = await connect(other);
    const thread = await other.createThread({ location: 'home', cwd: '/work' });
    const upgraded = newClient(home, { version: '99.0.0' });
    const fresh = await connect(upgraded);
    assert.notEqual(fresh.pid, old.pid);
    // The other terminal's next call reconnects, to the new daemon.
    await waitFor(() => !isProcessAlive(old.pid), 'the old daemon to exit');
    assert.deepEqual((await other.listThreads()).map((summary) => summary.id), [thread.id]);
    assert.equal((await other.status()).pid, fresh.pid);
  });

  it('never replaces a daemon newer than the client', async () => {
    const home = newHome();
    const current = await connect(newClient(home));
    const older = newClient(home, { version: '0.0.1' });
    assert.equal((await connect(older)).pid, current.pid);
    assert.ok(isProcessAlive(current.pid));
  });
});

describe('shelly daemon status and stop', () => {
  it('reports and stops the running daemon', async () => {
    const home = newHome();
    const run = (...args: string[]) => {
      const child: ChildProcess = spawn(process.execPath, [...EXEC_ARGV, ENTRY, 'daemon', ...args], {
        env: daemonEnv(home),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      child.stdout!.on('data', (chunk) => (output += chunk));
      return new Promise<{ code: number | null; output: string }>((resolve) => child.once('exit', (code) => resolve({ code, output })));
    };

    const before = await run('status');
    assert.equal(before.code, 1);
    assert.match(before.output, /not running/);

    const client = newClient(home);
    const hello = await connect(client);
    await client.close();
    const status = await run('status');
    assert.equal(status.code, 0);
    assert.match(status.output, new RegExp(`pid:\\s+${hello.pid}`));

    const stop = await run('stop');
    assert.equal(stop.code, 0);
    await waitFor(() => !isProcessAlive(hello.pid), 'the daemon to stop');
  });
});
