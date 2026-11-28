import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import * as RpcSchema from 'effect/rpc/RpcSchema';
import { DaemonClient, DaemonError } from '../../src/client/daemon-client.js';
import { DAEMON_RPCS, type DaemonRpcTag, RpcConnection } from '../../src/client/rpc-connection.js';
import { isProcessAlive } from '../../src/daemon/lock.js';
import { AgentUnavailable, ThreadBusy, ThreadNotFound, UnknownRequest } from '../../src/protocol/errors.js';
import { shellyPaths } from '../../src/protocol/paths.js';
import { DaemonRpcs } from '../../src/protocol/rpc.js';
import type { FastEvent, PromptContext, ThreadEvent } from '../../src/protocol/schema.js';

/*
 * The contract between the client's hand-written RPC client and the
 * daemon's Effect RpcServer: every RPC in DaemonRpcs, through DaemonClient,
 * against a real daemon process on its socket (with fake agents). Calls,
 * streams, typed errors, a stream stopped early, pings. Adding an RPC fails
 * this file until the client knows it and a test here calls it.
 */

const ENTRY = fileURLToPath(new URL('../../src/index.ts', import.meta.url));
const FAKE_RUNTIME = fileURLToPath(new URL('./fake-runtime.ts', import.meta.url));
const EXEC_ARGV = ['--experimental-ffi', '--no-warnings', '--import', import.meta.resolve('tsx')];

const CONTEXT: PromptContext = {
  cwd: '/work/app',
  environment: { os: 'TestOS', shell: 'zsh', shellVersion: null, terminal: null },
  commands: [],
};
const FAST_INPUT = { instruction: 'list files', buffer: '', cwd: '/', environment: CONTEXT.environment, recentCommands: [] };

const home = mkdtempSync(join(tmpdir(), 'shc-'));
const env = { ...process.env, SHELLY_HOME: home, SHELLY_DAEMON_TEST_RUNTIME: FAKE_RUNTIME };
const clients: DaemonClient[] = [];
const newClient = (): DaemonClient => {
  const client = new DaemonClient({ env, entry: ENTRY, execArgv: EXEC_ARGV, startTimeoutMs: 15_000 });
  clients.push(client);
  return client;
};
let daemonPid = 0;

after(async () => {
  await Promise.all(clients.map((client) => client.dispose().catch(() => undefined)));
  if (daemonPid && isProcessAlive(daemonPid)) {
    process.kill(daemonPid, 'SIGTERM');
    for (let waited = 0; waited < 5000 && isProcessAlive(daemonPid); waited += 20) {
      await sleep(20);
    }
    if (isProcessAlive(daemonPid)) {
      process.kill(daemonPid, 'SIGKILL');
    }
  }
  rmSync(home, { recursive: true, force: true });
});

/** The RPCs a test below called through the client. */
const exercised = new Set<DaemonRpcTag>();
const call = <A>(tag: DaemonRpcTag, promise: Promise<A>): Promise<A> => {
  exercised.add(tag);
  return promise;
};
const collect = async <A>(tag: DaemonRpcTag, stream: AsyncIterable<A>): Promise<A[]> => {
  exercised.add(tag);
  const out: A[] = [];
  for await (const value of stream) {
    out.push(value);
  }
  return out;
};

/** A daemon error as the client throws it: a DaemonError with the tag, fields and message of the daemon's own class. */
const rejectsWith = async (promise: Promise<unknown>, expected: { readonly _tag: string; readonly message: string }): Promise<void> => {
  const error = await promise.then(() => assert.fail(`expected ${expected._tag}`), (error: unknown) => error);
  assert.ok(error instanceof DaemonError, `a DaemonError, not ${String(error)}`);
  assert.equal(error._tag, expected._tag);
  assert.equal(error.message, expected.message);
  for (const [field, value] of Object.entries(expected)) {
    if (field !== 'message' && field !== 'stack') {
      assert.deepEqual(error[field], value, field);
    }
  }
};
const fields = (error: object & { readonly _tag: string; readonly message: string }) => ({ ...error, _tag: error._tag, message: error.message });

const types = (events: readonly ThreadEvent[]) => events.map((event) => event.type);

describe('the client and the daemon agree on every RPC', () => {
  const client = newClient();
  const other = newClient();

  it('knows every RPC in DaemonRpcs, and which of them stream', () => {
    const rpcs = [...DaemonRpcs.requests.values()];
    assert.deepEqual(Object.keys(DAEMON_RPCS).sort(), rpcs.map((rpc) => rpc._tag).sort());
    for (const rpc of rpcs) {
      const kind = RpcSchema.isStreamSchema(rpc.successSchema) ? 'stream' : 'call';
      assert.equal(DAEMON_RPCS[rpc._tag as DaemonRpcTag], kind, rpc._tag);
    }
  });

  it('says hello, starting the daemon', async () => {
    const hello = await call('hello', client.connect());
    daemonPid = hello.pid;
    assert.equal(hello.protocolVersion, 2);
    assert.equal(hello.daemonVersion, '0.1.0');
    assert.equal(typeof hello.pid, 'number');
  });

  it('lists agents and sets the default, or says why not', async () => {
    const agents = await call('agents.list', client.listAgents());
    assert.deepEqual(agents.map((agent) => [agent.id, agent.available, agent.isDefault]), [['fake', true, true], ['broken', false, false]]);
    await call('agents.setDefault', client.setDefaultAgent('fake'));
    const refused = await client.setDefaultAgent('nobody').then(() => undefined, (error: unknown) => error);
    assert.ok(refused instanceof DaemonError && refused._tag === 'AgentUnavailable' && refused.agentId === 'nobody');
    assert.ok(refused.message.length > 0 && refused.message === refused.reason, refused.message);
  });

  let threadId = '';

  it('creates, lists, attaches and detaches threads, with typed errors', async () => {
    const thread = await call('thread.create', client.createThread({ location: 'folder', cwd: '/work/app' }));
    threadId = thread.id;
    assert.equal(thread.cwd, '/work/app');
    assert.equal(thread.status, 'idle');
    await rejectsWith(client.createThread({ agentId: 'broken', location: 'home', cwd: '/' }), fields(new AgentUnavailable({ agentId: 'broken', reason: 'Broken is not installed.' })));

    assert.deepEqual((await call('thread.list', client.listThreads(10))).map((summary) => summary.id), [threadId]);
    assert.equal((await client.listThreads()).length, 1);

    const { thread: attached, history } = await call('thread.attach', client.attachThread(threadId));
    assert.equal(attached.attachedBy, client.clientId);
    assert.deepEqual(history, []);
    await rejectsWith(other.attachThread(threadId), fields(new ThreadBusy({ threadId, attachedBy: client.clientId })));
    await rejectsWith(client.attachThread('no-such-thread'), fields(new ThreadNotFound({ threadId: 'no-such-thread' })));

    await call('thread.detach', client.detachThread(threadId));
    assert.equal((await client.listThreads())[0]?.attachedBy, null);
    await client.attachThread(threadId);
  });

  it('streams a turn, then replays it to a watcher', async () => {
    await call('thread.prewarm', client.prewarmThread({ threadId, cwd: '/work/app' }));
    const events = await collect('thread.prompt', client.prompt(threadId, 'hello contract', CONTEXT, 'req-contract'));
    assert.deepEqual(types(events), ['turn.started', 'mode.changed', 'message.chunk', 'message.chunk', 'turn.ended']);
    assert.equal(events[0]?.type === 'turn.started' ? events[0].clientRequestId : null, 'req-contract', 'the request id, echoed');
    assert.equal(events.flatMap((event) => (event.type === 'message.chunk' ? [event.text] : [])).join(''), 'echo: hello contract');

    const watched = await collect('thread.watch', other.watch(threadId, 0));
    assert.deepEqual(types(watched), ['turn.started', 'mode.changed', 'message.chunk', 'turn.ended']);
    assert.equal(watched[0]?.type === 'turn.started' ? watched[0].clientRequestId : null, 'req-contract', 'and kept with the thread');
    assert.deepEqual(await collect('thread.watch', other.watch(threadId, watched.at(-1)!.seq)), []);
    await rejectsWith(collect('thread.watch', other.watch('no-such-thread')), fields(new ThreadNotFound({ threadId: 'no-such-thread' })));
    await rejectsWith(collect('thread.prompt', other.prompt(threadId, 'me too', CONTEXT)), fields(new ThreadBusy({ threadId, attachedBy: client.clientId })));
  });

  it('keeps a turn running when its stream is stopped early, and takes answers and a cancel', async () => {
    let requestId = '';
    for await (const event of client.prompt(threadId, 'ask permission first', CONTEXT)) {
      if (event.type === 'permission.requested') {
        requestId = event.requestId;
        break;
      }
    }
    assert.ok(requestId);
    // The stream was interrupted, the turn was not.
    assert.equal((await client.status()).runningTurns, 1);
    await rejectsWith(call('thread.respond', client.respond(threadId, 'no-such-request', null)), fields(new UnknownRequest({ requestId: 'no-such-request' })));
    await client.respond(threadId, requestId, 'allow');
    for (let waited = 0; (await client.status()).runningTurns > 0; waited += 20) {
      assert.ok(waited < 5000, 'the turn to end');
      await sleep(20);
    }
    const replay = await collect('thread.watch', client.watch(threadId, 0));
    assert.ok(types(replay).includes('permission.resolved'));

    const cancelled = client.prompt(threadId, 'ask permission again', CONTEXT)[Symbol.asyncIterator]();
    assert.equal((await cancelled.next()).value?.type, 'turn.started');
    await call('thread.cancel', client.cancel(threadId));
    let last: ThreadEvent | undefined;
    for (let next = await cancelled.next(); !next.done; next = await cancelled.next()) {
      last = next.value;
    }
    assert.equal(last?.type === 'turn.ended' && last.stopReason, 'cancelled');
  });

  it('reads and sets modes, renames and deletes threads', async () => {
    const modes = await call('thread.modes', client.threadModes(threadId));
    assert.equal(modes?.currentModeId, 'default');
    assert.deepEqual(modes?.availableModes.map((mode) => mode.id), ['default', 'plan']);
    await call('thread.setMode', client.setMode(threadId, 'plan'));
    await rejectsWith(other.setMode(threadId, 'plan'), fields(new ThreadBusy({ threadId, attachedBy: client.clientId })));

    await call('thread.rename', client.rename(threadId, 'the contract'));
    assert.equal((await client.listThreads())[0]?.title, 'the contract');
    await call('thread.delete', client.deleteThread(threadId));
    assert.deepEqual(await client.listThreads(), []);
    await rejectsWith(client.rename(threadId, 'gone'), fields(new ThreadNotFound({ threadId })));
  });

  it('runs fast requests, and stops listening to one early', async () => {
    await call('fast.prewarm', client.prewarmFast());
    await client.prewarmFast('fake');
    const events = await collect<FastEvent>('fast.request', client.fastRequest({ sessionKey: 's1', input: FAST_INPUT }));
    assert.deepEqual(events, [
      { type: 'delta', text: 'ls ' },
      { type: 'delta', text: '-la' },
      { type: 'done', text: 'ls -la', kind: 'command', durationMs: 1 },
    ]);
    await call('fast.end', client.endFast('s1'));
    const refused = await collect('fast.request', client.fastRequest({ agentId: 'broken', sessionKey: 's2', input: FAST_INPUT })).then(() => undefined, (error: unknown) => error);
    assert.ok(refused instanceof DaemonError && refused._tag === 'AgentUnavailable' && refused.message.length > 0);

    // A request that never finishes holds the daemon up (it is not idle) until the stream is let go,
    // as Esc lets it go: while a read waits for more.
    const slow = client.fastRequest({ sessionKey: 's3', input: { ...FAST_INPUT, instruction: 'slow' } })[Symbol.asyncIterator]();
    assert.deepEqual((await slow.next()).value, { type: 'delta', text: 'ls ' });
    const waiting = slow.next();
    assert.equal(await other.shutdown(true), false, 'busy while the stream is open');
    await slow.return?.();
    assert.deepEqual(await waiting, { done: true, value: undefined });
  });

  it('answers pings on a raw connection', async () => {
    const connection = await RpcConnection.open(shellyPaths(env).socket);
    try {
      await connection.ping();
      await connection.ping();
    } finally {
      connection.close();
    }
  });

  it('reports its status, and stops only when idle if asked so', async () => {
    const status = await call('daemon.status', client.status());
    assert.equal(status.pid, daemonPid);
    assert.equal(status.daemonVersion, '0.1.0');
    assert.equal(status.runningTurns, 0);
    assert.ok(status.clients >= 2);
    // The stopped fast stream above is closed on the daemon's side: it is idle now.
    let willStop = await call('daemon.shutdown', client.shutdown(true));
    for (let waited = 0; !willStop && waited < 3000; waited += 50) {
      await sleep(50);
      willStop = await client.shutdown(true);
    }
    assert.equal(willStop, true);
    for (let waited = 0; isProcessAlive(daemonPid); waited += 20) {
      assert.ok(waited < 5000, 'the daemon to exit');
      await sleep(20);
    }
  });

  it('called every RPC above', () => {
    assert.deepEqual([...exercised].sort(), Object.keys(DAEMON_RPCS).sort());
  });
});
