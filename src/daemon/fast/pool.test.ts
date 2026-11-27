import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FastPool } from './pool.js';
import type { FastBackend, FastWorker } from './worker.js';

/** A worker that does nothing but live until killed. */
const stubBackend = () => {
  const workers: FastWorker[] = [];
  const backend: FastBackend = {
    key: 'stub',
    spawn: () => {
      let alive = true;
      let exit!: () => void;
      const exited = new Promise<void>((resolve) => (exit = resolve));
      const worker: FastWorker = {
        pid: undefined,
        get alive() {
          return alive;
        },
        send: () => ({ cancel: () => {} }),
        kill: () => {
          alive = false;
          exit();
        },
        exited,
      };
      workers.push(worker);
      return worker;
    },
  };
  return { backend, workers };
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('FastPool', () => {
  it('drops the warm worker after the keep-warm window, even when the timer fires early', async () => {
    // The clock says less time has passed than the timer waited, as when a timer fires a little early.
    let clock = 0;
    const pool = new FastPool({ keepWarmMs: 50, sessionIdleMs: 60_000, maxSessions: 2, now: () => clock });
    const { backend, workers } = stubBackend();
    try {
      pool.prewarm('a', backend);
      assert.equal(pool.workerCount, 1);
      clock = 49;
      await new Promise((resolve) => setTimeout(resolve, 80));
      assert.equal(workers[0]!.alive, true, 'not yet, by the clock');
      clock = 50;
      await new Promise((resolve) => setTimeout(resolve, 80));
      await settle();
      assert.equal(workers[0]!.alive, false, 'dropped once the clock says the window is over');
      assert.equal(pool.workerCount, 0);
    } finally {
      await pool.close();
    }
  });

  it('keeps the warm worker while requests keep coming within the window', async () => {
    let clock = 0;
    const pool = new FastPool({ keepWarmMs: 1000, sessionIdleMs: 60_000, maxSessions: 2, now: () => clock });
    const { backend, workers } = stubBackend();
    try {
      pool.prewarm('a', backend);
      clock = 900;
      pool.prewarm('a', backend);
      assert.equal(workers.length, 1, 'still warm: no second worker');
      assert.equal(workers[0]!.alive, true);
    } finally {
      await pool.close();
    }
  });
});
