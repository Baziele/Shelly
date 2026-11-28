import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { DaemonClient } from './daemon-client.js';
import { DaemonLink } from './daemon-link.js';

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};

const fakeClient = () => {
  const state = { connected: 0, disposed: 0 };
  const client = {
    connect: () => {
      state.connected++;
      return Promise.resolve({ protocolVersion: 2, daemonVersion: '0', pid: 1 });
    },
    dispose: () => {
      state.disposed++;
      return Promise.resolve();
    },
  } as unknown as DaemonClient;
  return { client, state };
};

describe('DaemonLink', () => {
  it('makes no client when disposed while the daemon is starting', async () => {
    const started = deferred();
    let made = 0;
    const link = new DaemonLink({
      env: {},
      ensureStarted: () => started.promise,
      createClient: () => {
        made++;
        return Promise.resolve(fakeClient().client);
      },
    });
    const loading = link.get();
    await link.dispose();
    started.resolve();
    await assert.rejects(loading, /exiting/);
    assert.equal(made, 0, 'no client was made after dispose');
  });

  it('closes a client that finished connecting after dispose', async () => {
    const { client, state } = fakeClient();
    const made = deferred();
    let making = false;
    const link = new DaemonLink({
      env: {},
      ensureStarted: () => Promise.resolve(),
      createClient: async () => {
        making = true;
        await made.promise;
        return client;
      },
    });
    const loading = link.get();
    while (!making) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    const disposing = link.dispose();
    made.resolve();
    await disposing;
    await assert.rejects(loading, /exiting/);
    assert.equal(state.disposed, 1, 'the late client is disposed');
    await assert.rejects(link.get(), /exiting/, 'and nothing loads afterwards');
  });
});
