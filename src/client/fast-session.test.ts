import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { FastEvent, FastInput } from '../protocol/schema.js';
import type { DaemonClient } from './daemon-client.js';
import type { FlowHost, OpenInput } from './flow-host.js';
import { cleanPreview, FastSession } from './fast-session.js';

/** A stream the test feeds by hand, recording whether the reader let go of it. */
class FakeStream implements AsyncIterator<FastEvent> {
  returned = false;
  private waiting: ((result: IteratorResult<FastEvent>) => void) | undefined;

  next(): Promise<IteratorResult<FastEvent>> {
    return new Promise((resolve) => (this.waiting = resolve));
  }

  return(): Promise<IteratorResult<FastEvent>> {
    this.returned = true;
    this.waiting?.({ done: true, value: undefined });
    return Promise.resolve({ done: true, value: undefined });
  }

  push(event: FastEvent): void {
    this.waiting?.({ done: false, value: event });
  }

  end(): void {
    this.waiting?.({ done: true, value: undefined });
  }
}

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
};

const tick = () => new Promise((resolve) => setImmediate(resolve));

const setup = () => {
  const requests: { sessionKey: string; input: FastInput; stream: FakeStream }[] = [];
  const ended: string[] = [];
  const client = {
    fastRequest: ({ sessionKey, input }: { sessionKey: string; input: FastInput }) => {
      const stream = new FakeStream();
      requests.push({ sessionKey, input, stream });
      return { [Symbol.asyncIterator]: () => stream };
    },
    endFast: (sessionKey: string) => {
      ended.push(sessionKey);
      return Promise.resolve();
    },
    prewarmFast: () => Promise.resolve(),
  } as unknown as DaemonClient;
  const connection = deferred<DaemonClient>();
  const events: string[] = [];
  const host = {
    link: { get: () => connection.promise, loaded: client, lastError: undefined },
    overlay: {
      mode: 'fast',
      isOpen: true,
      setBusy: (busy: boolean) => events.push(`busy:${busy}`),
      setPreview: () => undefined,
      setError: (message: string) => events.push(`error:${message}`),
      close: () => events.push('close'),
    },
    commands: { recent: () => Promise.resolve([]), cwd: '/work' },
    environment: () => Promise.resolve({ os: 'TestOS', shell: 'zsh', shellVersion: undefined, terminal: undefined }),
    cwd: () => '/work',
    lineEditor: { canReplace: true },
    claim: () => undefined,
    release: () => events.push('release'),
  } as unknown as FlowHost;
  const session = new FastSession(host, 'term');
  const open: OpenInput = { trigger: '__', mode: 'fast', rewrite: undefined };
  return { session, open, connection, client, requests, ended, events };
};

describe('FastSession', () => {
  it('never sends a request the user stopped while it was getting ready', async () => {
    const { session, open, connection, client, requests, events } = setup();
    session.submit(open, 'list files');
    session.cancel();
    connection.resolve(client);
    await tick();
    await tick();
    assert.equal(requests.length, 0, 'no request reached the daemon');
    assert.deepEqual(events.filter((event) => event !== 'busy:true'), ['close', 'release']);
  });

  it('lets go of a running request on Esc, and starts the next on a fresh session', async () => {
    const { session, open, connection, client, requests, ended } = setup();
    connection.resolve(client);
    session.submit(open, 'first');
    await tick();
    await tick();
    assert.equal(requests.length, 1);
    const first = requests[0]!;
    session.cancel();
    await tick();
    assert.ok(first.stream.returned, 'the stream, and so the daemon request, is closed');
    assert.deepEqual(ended, [first.sessionKey], 'the stopped conversation is let go');

    session.submit(open, 'second');
    await tick();
    await tick();
    assert.equal(requests.length, 2);
    assert.notEqual(requests[1]!.sessionKey, first.sessionKey, 'never on the stopped one');
  });

  it('continues the conversation on the same session when nothing was stopped', async () => {
    const { session, open, connection, client, requests, events } = setup();
    connection.resolve(client);
    session.submit(open, 'first');
    await tick();
    await tick();
    requests[0]!.stream.push({ type: 'done', text: 'ls -la', kind: 'command', durationMs: 5 });
    await tick();
    requests[0]!.stream.end();
    await tick();
    await tick();
    assert.ok(events.includes('release'), 'the command went on the line');
    session.submit(open, 'make it recursive');
    await tick();
    await tick();
    assert.equal(requests[1]?.sessionKey, requests[0]!.sessionKey);
  });
});

describe('cleanPreview', () => {
  it('drops the dressing the final reply loses', () => {
    assert.equal(cleanPreview('```bash\nls -la'), 'ls -la');
    assert.equal(cleanPreview('# Use ls'), 'Use ls');
    assert.equal(cleanPreview('$ ls'), 'ls');
  });
});
