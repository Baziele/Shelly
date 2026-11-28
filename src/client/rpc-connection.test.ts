import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, describe, it } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { DaemonDisconnected, DaemonError, errorOfCause, RpcConnection } from './rpc-connection.js';

/*
 * The raw RPC client against a scripted server speaking Effect RPC's NDJSON
 * messages. test/e2e/daemon-contract.e2e.ts checks it against the real one.
 */

const dir = mkdtempSync(join(tmpdir(), 'rpc-'));
after(() => rmSync(dir, { recursive: true, force: true }));

type Message = Record<string, unknown>;

interface Fake {
  readonly path: string;
  /** Every message the client sent, in order. */
  readonly received: Message[];
  send(message: Message): void;
  /** Resolves with the next message the client sends that matches. */
  next(match: (message: Message) => boolean): Promise<Message>;
  dropClient(): void;
}

const servers: Server[] = [];
const connections: RpcConnection[] = [];
let count = 0;

afterEach(async () => {
  connections.splice(0).forEach((connection) => connection.close());
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

const fakeServer = async (): Promise<Fake> => {
  const path = join(dir, `s${++count}.sock`);
  const received: Message[] = [];
  const waiters: { match: (message: Message) => boolean; resolve: (message: Message) => void }[] = [];
  let client: Socket | undefined;
  const server = createServer((socket) => {
    client = socket;
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (data: string) => {
      buffer += data;
      for (let newline = buffer.indexOf('\n'); newline !== -1; newline = buffer.indexOf('\n')) {
        const message = JSON.parse(buffer.slice(0, newline)) as Message;
        buffer = buffer.slice(newline + 1);
        received.push(message);
        const waiter = waiters.findIndex((entry) => entry.match(message));
        if (waiter !== -1) {
          waiters.splice(waiter, 1)[0]!.resolve(message);
        }
      }
    });
    socket.on('error', () => undefined);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(path, resolve));
  return {
    path,
    received,
    send: (message) => client?.write(`${JSON.stringify(message)}\n`),
    next: (match) => {
      const seen = received.find(match);
      return seen ? Promise.resolve(seen) : new Promise((resolve) => waiters.push({ match, resolve }));
    },
    dropClient: () => client?.destroy(),
  };
};

const open = async (fake: Fake, onClose?: () => void): Promise<RpcConnection> => {
  const connection = await RpcConnection.open(fake.path, onClose);
  connections.push(connection);
  return connection;
};

const requestFor = (tag: string) => (message: Message) => message._tag === 'Request' && message.tag === tag;

describe('RpcConnection', () => {
  it('sends a request as Effect RPC does, and resolves with its exit', async () => {
    const fake = await fakeServer();
    const connection = await open(fake);
    const result = connection.call('agents.list', undefined);
    const request = await fake.next(requestFor('agents.list'));
    // No payload is sent as null, which the daemon decodes as void.
    assert.deepEqual(request, { _tag: 'Request', id: request.id, tag: 'agents.list', payload: null, headers: [] });
    assert.equal(typeof request.id, 'string');
    fake.send({ _tag: 'Exit', requestId: request.id, exit: { _tag: 'Success', value: [{ id: 'fake' }] } });
    assert.deepEqual(await result, [{ id: 'fake' }]);
  });

  it('throws a typed failure with its tag, fields and the message the daemon gives it', async () => {
    const fake = await fakeServer();
    const connection = await open(fake);
    const result = connection.call('thread.attach', { threadId: 't1' });
    const request = await fake.next(requestFor('thread.attach'));
    fake.send({
      _tag: 'Exit',
      requestId: request.id,
      exit: { _tag: 'Failure', cause: [{ _tag: 'Fail', error: { _tag: 'ThreadBusy', threadId: 't1', attachedBy: 'other' } }] },
    });
    const error = await result.then(() => assert.fail('it resolved'), (error: unknown) => error);
    assert.ok(error instanceof DaemonError && error instanceof Error);
    assert.equal(error._tag, 'ThreadBusy');
    assert.equal(error.attachedBy, 'other');
    assert.equal(error.message, 'That thread is open in another terminal.');
  });

  it('reads the other kinds of failure: interrupted (a daemon stopping), a defect, an unknown error', () => {
    assert.ok(errorOfCause([{ _tag: 'Interrupt', fiberId: 3 }]) instanceof DaemonDisconnected);
    assert.match(errorOfCause([{ _tag: 'Die', defect: { name: 'Error', message: 'boom' } }]).message, /boom/);
    assert.match(errorOfCause([{ _tag: 'Die', defect: 'Unknown request tag: x' }]).message, /Unknown request tag: x/);
    const unknown = errorOfCause([{ _tag: 'Fail', error: { _tag: 'SomethingNew', message: 'it is new' } }]);
    assert.equal((unknown as DaemonError)._tag, 'SomethingNew');
    assert.equal(unknown.message, 'it is new');
    assert.equal(errorOfCause([{ _tag: 'Fail', error: { _tag: 'AgentUnavailable', agentId: 'x', reason: 'Not installed.' } }]).message, 'Not installed.');
  });

  it('streams chunks, acknowledging each, until the exit', async () => {
    const fake = await fakeServer();
    const connection = await open(fake);
    const values: unknown[] = [];
    const reading = (async () => {
      for await (const value of connection.stream('fast.request', { sessionKey: 's' }, () => 'yield')) {
        values.push(value);
      }
    })();
    const request = await fake.next(requestFor('fast.request'));
    fake.send({ _tag: 'Chunk', requestId: request.id, values: [{ type: 'delta', text: 'a' }, { type: 'delta', text: 'b' }] });
    await fake.next((message) => message._tag === 'Ack' && message.requestId === request.id);
    fake.send({ _tag: 'Chunk', requestId: request.id, values: [{ type: 'done', text: 'ab' }] });
    await sleep(20);
    assert.equal(fake.received.filter((message) => message._tag === 'Ack').length, 2);
    fake.send({ _tag: 'Exit', requestId: request.id, exit: { _tag: 'Success' } });
    await reading;
    assert.deepEqual(values, [{ type: 'delta', text: 'a' }, { type: 'delta', text: 'b' }, { type: 'done', text: 'ab' }]);
    assert.ok(!fake.received.some((message) => message._tag === 'Interrupt'), 'no interrupt for a stream that ended');
  });

  it('interrupts a stream the reader stops early', async () => {
    const fake = await fakeServer();
    const connection = await open(fake);
    const reading = (async () => {
      for await (const value of connection.stream('thread.watch', { threadId: 't' }, () => 'yield')) {
        return value;
      }
      return undefined;
    })();
    const request = await fake.next(requestFor('thread.watch'));
    fake.send({ _tag: 'Chunk', requestId: request.id, values: [1, 2, 3] });
    assert.equal(await reading, 1);
    assert.deepEqual(await fake.next((message) => message._tag === 'Interrupt'), { _tag: 'Interrupt', requestId: request.id });
    // The connection carries on.
    const status = connection.call('daemon.status', undefined);
    const next = await fake.next(requestFor('daemon.status'));
    fake.send({ _tag: 'Exit', requestId: next.id, exit: { _tag: 'Success', value: { pid: 1 } } });
    assert.deepEqual(await status, { pid: 1 });
  });

  it('stops at once when told to while a read waits, as when Esc cancels a fast request', async () => {
    const fake = await fakeServer();
    const connection = await open(fake);
    const iterator = connection.stream('fast.request', {}, () => 'yield')[Symbol.asyncIterator]();
    const waiting = iterator.next();
    const request = await fake.next(requestFor('fast.request'));
    assert.deepEqual(await iterator.return!(), { done: true, value: undefined });
    assert.deepEqual(await waiting, { done: true, value: undefined });
    assert.deepEqual(await fake.next((message) => message._tag === 'Interrupt'), { _tag: 'Interrupt', requestId: request.id });
    // Late chunks for it are ignored.
    fake.send({ _tag: 'Chunk', requestId: request.id, values: ['late'] });
    assert.deepEqual(await iterator.next(), { done: true, value: undefined });
  });

  it('serves reads asked for at once, in order', async () => {
    const fake = await fakeServer();
    const connection = await open(fake);
    const iterator = connection.stream<number>('thread.watch', {}, () => 'yield')[Symbol.asyncIterator]();
    const reads = [iterator.next(), iterator.next(), iterator.next()];
    const request = await fake.next(requestFor('thread.watch'));
    fake.send({ _tag: 'Chunk', requestId: request.id, values: [1, 2] });
    fake.send({ _tag: 'Exit', requestId: request.id, exit: { _tag: 'Success' } });
    assert.deepEqual(await Promise.all(reads), [{ done: false, value: 1 }, { done: false, value: 2 }, { done: true, value: undefined }]);
  });

  it('skips values its guard does not know, and breaks on ones it cannot read', async () => {
    const fake = await fakeServer();
    const connection = await open(fake);
    const guard = (value: unknown) => (value === 'new' ? 'skip' : value === 'bad' ? 'reject' : 'yield');
    const values: unknown[] = [];
    const reading = (async () => {
      for await (const value of connection.stream('thread.prompt', {}, guard)) {
        values.push(value);
      }
    })();
    const request = await fake.next(requestFor('thread.prompt'));
    fake.send({ _tag: 'Chunk', requestId: request.id, values: ['a', 'new', 'b', 'bad', 'c'] });
    await assert.rejects(reading, /does not understand/);
    assert.deepEqual(values, ['a', 'b']);
    await fake.next((message) => message._tag === 'Interrupt');
  });

  it('holds back its ack while a slow reader has many values waiting', async () => {
    const fake = await fakeServer();
    const connection = await open(fake);
    const iterator = connection.stream<number>('thread.watch', {}, () => 'yield')[Symbol.asyncIterator]();
    const first = iterator.next();
    const request = await fake.next(requestFor('thread.watch'));
    fake.send({ _tag: 'Chunk', requestId: request.id, values: Array.from({ length: 100 }, (_, index) => index) });
    assert.deepEqual(await first, { done: false, value: 0 });
    await sleep(20);
    assert.ok(!fake.received.some((message) => message._tag === 'Ack'), 'no ack yet');
    for (let index = 1; index < 70; index++) {
      await iterator.next();
    }
    await fake.next((message) => message._tag === 'Ack');
    await iterator.return?.();
  });

  it('answers pings, and its own pings are answered', async () => {
    const fake = await fakeServer();
    const connection = await open(fake);
    fake.send({ _tag: 'Ping' });
    await fake.next((message) => message._tag === 'Pong');
    const ping = connection.ping();
    await fake.next((message) => message._tag === 'Ping');
    fake.send({ _tag: 'Pong' });
    await ping;
  });

  it('fails what is in flight with DaemonDisconnected when the socket closes, and says so once', async () => {
    const fake = await fakeServer();
    let closes = 0;
    const connection = await open(fake, () => closes++);
    const call = connection.call('daemon.status', undefined);
    const stream = (async () => {
      for await (const _ of connection.stream('thread.watch', {}, () => 'yield')) {
        // nothing comes
      }
    })();
    await fake.next(requestFor('thread.watch'));
    fake.dropClient();
    await assert.rejects(call, DaemonDisconnected);
    await assert.rejects(stream, DaemonDisconnected);
    assert.equal(connection.isOpen, false);
    await assert.rejects(connection.call('daemon.status', undefined), DaemonDisconnected);
    connection.close();
    assert.equal(closes, 1);
  });

  it('fails everything on a defect for the connection', async () => {
    const fake = await fakeServer();
    const connection = await open(fake);
    const call = connection.call('daemon.status', undefined);
    await fake.next(requestFor('daemon.status'));
    fake.send({ _tag: 'Defect', defect: 'Unknown request tag: nope' });
    await assert.rejects(call, /Unknown request tag: nope/);
    assert.equal(connection.isOpen, false);
  });
});
