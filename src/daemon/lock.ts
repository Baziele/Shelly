import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';

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

/**
 * Take the lock for this process. `isStale` decides about a holder that is
 * still alive (its pid may have been reused by an unrelated process).
 */
export const acquireLock = (
  path: string,
  { isStale = () => false, now = Date.now() }: { isStale?: (holder: LockHolder) => boolean; now?: number } = {},
): LockResult => {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const fd = openSync(path, 'wx', 0o600);
      try {
        writeSync(fd, JSON.stringify({ pid: process.pid, startedAt: now }));
      } finally {
        closeSync(fd);
      }
      return { acquired: true };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }
    }
    const holder = readLock(path);
    if (holder && holder.pid !== process.pid && isProcessAlive(holder.pid) && !isStale(holder)) {
      return { acquired: false, holder };
    }
    // Stale, unreadable, or ours from an earlier run in this process: replace it.
    try {
      unlinkSync(path);
    } catch {
      // Someone else removed it first; try again.
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
