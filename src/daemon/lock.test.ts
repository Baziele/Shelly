import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { acquireLock, readLock } from './lock.js';

const dirs: string[] = [];
after(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));
const lockPath = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'shelly-lock-'));
  dirs.push(dir);
  return join(dir, 'daemon.lock');
};

const DEAD = 999_999;
const alive = (...pids: number[]) => (pid: number) => pids.includes(pid);

describe('acquireLock', () => {
  it('takes a free lock and refuses a live holder', () => {
    const path = lockPath();
    assert.deepEqual(acquireLock(path, { pid: 101, isAlive: alive(101, 102) }), { acquired: true });
    const second = acquireLock(path, { pid: 102, isAlive: alive(101, 102) });
    assert.equal(second.acquired, false);
    assert.equal(second.acquired ? 0 : second.holder.pid, 101);
  });

  it('takes over a lock whose holder is dead', () => {
    const path = lockPath();
    writeFileSync(path, JSON.stringify({ pid: DEAD, startedAt: 1 }));
    assert.deepEqual(acquireLock(path, { pid: 101, isAlive: alive(101) }), { acquired: true });
    assert.equal(readLock(path)?.pid, 101);
  });

  it('lets exactly one of two racing daemons take over a stale lock', () => {
    const path = lockPath();
    writeFileSync(path, JSON.stringify({ pid: DEAD, startedAt: 1 }));
    const isAlive = alive(101, 102);
    let second: ReturnType<typeof acquireLock> | undefined;
    // Daemon 101 judges the lock stale; before it replaces it, daemon 102 does the same and wins.
    const first = acquireLock(path, {
      pid: 101,
      isAlive,
      beforeTakeover: () => {
        second ??= acquireLock(path, { pid: 102, isAlive });
      },
    });
    const winners = [first, second].filter((result) => result?.acquired).length;
    assert.equal(winners, 1, 'exactly one daemon holds the lock');
    assert.equal(readLock(path)?.pid, first.acquired ? 101 : 102);
    assert.deepEqual(readdirSync(join(path, '..')), ['daemon.lock'], 'no takeover files left behind');
  });

  it('clears a takeover file left by a daemon that crashed mid-takeover', () => {
    const path = lockPath();
    writeFileSync(path, JSON.stringify({ pid: DEAD, startedAt: 1 }));
    writeFileSync(`${path}.takeover`, String(DEAD));
    const old = new Date(Date.now() - 60_000);
    utimesSync(`${path}.takeover`, old, old);
    assert.deepEqual(acquireLock(path, { pid: 101, isAlive: alive(101) }), { acquired: true });
    assert.equal(readLock(path)?.pid, 101);
  });
});
