import { randomBytes } from 'node:crypto';
import { linkSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';

/*
 * The single-instance lock, `run/daemon.lock`: the pid and start time of the
 * daemon that owns the run directory. Created exclusively; a lock whose pid
 * is gone is stale and taken over.
 */

export interface LockHolder {
  readonly pid: number;
  readonly startedAt: number;
}

export type LockResult = { readonly acquired: true } | { readonly acquired: false; readonly holder: LockHolder };

export const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};

export const readLock = (path: string): LockHolder | undefined => {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<LockHolder>;
    return typeof parsed.pid === 'number' && typeof parsed.startedAt === 'number'
      ? { pid: parsed.pid, startedAt: parsed.startedAt }
      : undefined;
  } catch {
    return undefined;
  }
};

export interface AcquireOptions {
  readonly isStale?: ((holder: LockHolder) => boolean) | undefined;
  readonly now?: number | undefined;
  /** For tests: act as another process. */
  readonly pid?: number | undefined;
  readonly isAlive?: ((pid: number) => boolean) | undefined;
  /** For tests: runs after a holder is judged stale, before it is replaced. */
  readonly beforeTakeover?: (() => void) | undefined;
}

/** A takeover file older than this was left by a daemon that crashed mid-takeover. */
const TAKEOVER_STALE_MS = 2000;
const ATTEMPTS = 200;

const sleepSync = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

const isExists = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'EEXIST';

/**
 * Create the lock only if there is none, with its content already in place:
 * written to a private file, then hard-linked to the lock's name (which
 * fails if the name exists). A reader never sees a half-written lock.
 */
const createLock = (path: string, holder: LockHolder): boolean => {
  const temporary = `${path}.${holder.pid}.${randomBytes(4).toString('hex')}`;
  writeFileSync(temporary, JSON.stringify(holder), { mode: 0o600, flag: 'wx' });
  try {
    linkSync(temporary, path);
    return true;
  } catch (error) {
    if (isExists(error)) {
      return false;
    }
    throw error;
  } finally {
    unlinkSync(temporary);
  }
};

/** Only one daemon at a time may replace a stale lock; this file says who. */
const tryTakeoverMutex = (mutex: string, pid: number): boolean => {
  try {
    writeFileSync(mutex, String(pid), { mode: 0o600, flag: 'wx' });
    return true;
  } catch (error) {
    if (!isExists(error)) {
      throw error;
    }
    try {
      if (Date.now() - statSync(mutex).mtimeMs > TAKEOVER_STALE_MS) {
        unlinkSync(mutex);
      }
    } catch {
      // Released meanwhile.
    }
    return false;
  }
};

/**
 * Take the lock for this process. `isStale` decides about a holder that is
 * still alive (its pid may have been reused by an unrelated process).
 *
 * A stale lock is replaced under a takeover mutex, after reading it again:
 * when two daemons start together, exactly one takes over and the other
 * then finds a live holder.
 */
export const acquireLock = (
  path: string,
  { isStale = () => false, now = Date.now(), pid = process.pid, isAlive = isProcessAlive, beforeTakeover }: AcquireOptions = {},
): LockResult => {
  const self: LockHolder = { pid, startedAt: now };
  const live = (holder: LockHolder | undefined): holder is LockHolder =>
    holder !== undefined && holder.pid !== pid && isAlive(holder.pid) && !isStale(holder);
  const mutex = `${path}.takeover`;

  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    if (createLock(path, self)) {
      return { acquired: true };
    }
    const holder = readLock(path);
    if (live(holder)) {
      return { acquired: false, holder };
    }
    // Stale, unreadable, or ours from an earlier run in this process: replace it.
    beforeTakeover?.();
    if (!tryTakeoverMutex(mutex, pid)) {
      sleepSync(5);
      continue;
    }
    try {
      const current = readLock(path);
      if (live(current)) {
        return { acquired: false, holder: current };
      }
      try {
        unlinkSync(path);
      } catch {
        // Already gone.
      }
      if (createLock(path, self)) {
        return { acquired: true };
      }
    } finally {
      unlinkSync(mutex);
    }
  }
  const holder = readLock(path);
  return holder ? { acquired: false, holder } : { acquired: false, holder: { pid: 0, startedAt: 0 } };
};

/** Remove the lock if this process still holds it. */
export const releaseLock = (path: string): void => {
  if (readLock(path)?.pid === process.pid) {
    try {
      unlinkSync(path);
    } catch {
      // Already gone.
    }
  }
};
