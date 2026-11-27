import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { type ChildProcess, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
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

describe('acquireLock (the file-based fallback)', () => {
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

  it('never removes a takeover mutex that another daemon has taken meanwhile', () => {
    const path = lockPath();
    const mutex = `${path}.takeover`;
    writeFileSync(path, JSON.stringify({ pid: DEAD, startedAt: 1 }));
    // While 101 is inside the mutex, a peer decides it is stale and takes it.
    const result = acquireLock(path, {
      pid: 101,
      isAlive: alive(101, 102),
      duringTakeover: () => writeFileSync(mutex, 'peer-token'),
    });
    assert.equal(result.acquired, true);
    assert.equal(existsSync(mutex) ? readFileSync(mutex, 'utf8') : null, 'peer-token', "the peer's mutex is left alone");
  });

  it('waits out a mutex left by a crashed takeover rather than giving up', () => {
    const path = lockPath();
    writeFileSync(path, JSON.stringify({ pid: DEAD, startedAt: 1 }));
    writeFileSync(`${path}.takeover`, String(DEAD));
    // Not stale yet: it goes stale 1.5 s from now.
    const recent = new Date(Date.now() - 500);
    utimesSync(`${path}.takeover`, recent, recent);
    assert.deepEqual(acquireLock(path, { pid: 101, isAlive: alive(101) }), { acquired: true });
    assert.equal(readLock(path)?.pid, 101);
  });
});

// ─── flock, in processes of their own ───────────────────────────────────────

const CHILD = fileURLToPath(new URL('./testing/lock-child.ts', import.meta.url));
const children: ChildProcess[] = [];
after(() => children.forEach((child) => child.kill('SIGKILL')));

/** Take the lock in a child process; resolves with what it reported. */
const lockInChild = (path: string) => {
  const child = spawn(process.execPath, ['--experimental-ffi', '--no-warnings', '--import', 'tsx', CHILD, path], {
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  children.push(child);
  const reported = new Promise<{ acquired: boolean; mechanism?: string; holder?: { pid: number } }>((resolve) => {
    let out = '';
    child.stdout!.on('data', (chunk) => {
      out += chunk;
      if (out.includes('\n')) {
        resolve(JSON.parse(out.split('\n')[0]!));
      }
    });
  });
  const exited = new Promise((resolve) => child.once('exit', resolve));
  return { child, reported, exited };
};

describe('acquireDaemonLock with flock', () => {
  it('lets one process hold it and tells the others who does', async () => {
    const path = lockPath();
    const first = lockInChild(path);
    assert.deepEqual(await first.reported, { acquired: true, mechanism: 'flock' });
    const second = lockInChild(path);
    const refused = await second.reported;
    assert.equal(refused.acquired, false);
    assert.equal(refused.holder?.pid, first.child.pid);
    first.child.stdin!.end();
    await first.exited;
  });

  it('is free again the moment its holder is killed', async () => {
    const path = lockPath();
    const holder = lockInChild(path);
    assert.equal((await holder.reported).acquired, true);
    holder.child.kill('SIGKILL');
    await holder.exited;
    // The file still names the dead holder; the kernel has dropped its lock.
    assert.equal(readLock(path)?.pid, holder.child.pid);
    const next = lockInChild(path);
    assert.deepEqual(await next.reported, { acquired: true, mechanism: 'flock' });
    assert.equal(readLock(path)?.pid, next.child.pid);
    next.child.stdin!.end();
    await next.exited;
  });

  it('lets exactly one of several processes starting together take it', async () => {
    const path = lockPath();
    writeFileSync(path, JSON.stringify({ pid: DEAD, startedAt: 1, mechanism: 'flock' }));
    const racers = Array.from({ length: 6 }, () => lockInChild(path));
    const results = await Promise.all(racers.map((racer) => racer.reported));
    assert.equal(results.filter((result) => result.acquired).length, 1);
    for (const racer of racers) {
      racer.child.stdin!.end();
    }
    await Promise.all(racers.map((racer) => racer.exited));
  });
});
