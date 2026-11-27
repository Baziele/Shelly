import { randomBytes } from 'node:crypto';
import {
  closeSync,
  constants,
  ftruncateSync,
  linkSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { probeSocketState, type SocketState } from '../protocol/probe.js';

/*
 * The single-instance lock, `run/daemon.lock`.
 *
 * Normally it is an flock(2) on the file, called through node:ffi: the
 * kernel drops it when the daemon exits, however it exits, so there is no
 * stale lock to take over and no race in taking one over. The file also
 * holds the daemon's pid and start time, for information only.
 *
 * Where node:ffi is unavailable, a file-based lock stands in: the file is
 * created exclusively, and a lock whose pid is gone is replaced under a
 * takeover mutex (see acquireLock).
 */

export interface LockHolder {
  readonly pid: number;
  readonly startedAt: number;
  readonly mechanism?: LockMechanism | undefined;
}

export type LockMechanism = 'flock' | 'file';

export type LockResult = { readonly acquired: true } | { readonly acquired: false; readonly holder: LockHolder };

export interface HeldLock {
  readonly mechanism: LockMechanism;
  /** Let go of the lock (on exit; the kernel does it anyway for flock). */
  release(): void;
}

export type DaemonLockResult =
  | { readonly acquired: true; readonly lock: HeldLock }
  | { readonly acquired: false; readonly holder: LockHolder | undefined };

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
      ? { pid: parsed.pid, startedAt: parsed.startedAt, mechanism: parsed.mechanism }
      : undefined;
  } catch {
    return undefined;
  }
};

const isErrno = (error: unknown, code: string): boolean => (error as NodeJS.ErrnoException).code === code;

const sleepSync = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

// ─── flock(2) through node:ffi ──────────────────────────────────────────────

const LOCK_EX = 2;
const LOCK_NB = 4;
const EINTR = 4;
/** "Someone else holds it": EWOULDBLOCK, 35 on macOS and the BSDs, 11 on Linux. */
const EWOULDBLOCK = process.platform === 'linux' ? 11 : 35;

interface Flock {
  /** 0, or the errno it failed with. */
  readonly tryLock: (fd: number) => number;
}

let flockLoad: Promise<Flock | undefined> | undefined;

/** flock from the C library, or undefined where node:ffi cannot reach it. */
export const loadFlock = (): Promise<Flock | undefined> =>
  (flockLoad ??= (async () => {
    try {
      const ffi = await import('node:ffi');
      const errnoSymbol = process.platform === 'linux' ? '__errno_location' : '__error';
      const { functions } = ffi.dlopen(null, {
        flock: { arguments: ['int32', 'int32'], return: 'int32' },
        [errnoSymbol]: { arguments: [], return: 'pointer' },
      });
      const flock = functions.flock as (fd: number, operation: number) => number;
      const errnoPointer = functions[errnoSymbol] as () => bigint;
      return {
        tryLock: (fd: number) => {
          for (let attempt = 0; attempt < 5; attempt++) {
            if (flock(fd, LOCK_EX | LOCK_NB) === 0) {
              return 0;
            }
            const errno = ffi.getInt32(errnoPointer(), 0);
            if (errno !== EINTR) {
              return errno;
            }
          }
          return EINTR;
        },
      };
    } catch {
      return undefined;
    }
  })());

const acquireFlock = (path: string, flock: Flock, holder: LockHolder, isStale: (holder: LockHolder) => boolean): DaemonLockResult => {
  const fd = openSync(path, constants.O_RDWR | constants.O_CREAT, 0o600);
  const errno = flock.tryLock(fd);
  if (errno !== 0) {
    closeSync(fd);
    if (errno !== EWOULDBLOCK) {
      throw new Error(`Could not lock ${path} (errno ${errno}).`);
    }
    return { acquired: false, holder: readLock(path) };
  }
  // A daemon using the file-based lock (no node:ffi) does not flock: respect
  // it, unless its pid now belongs to something else (`isStale`).
  const previous = readLock(path);
  if (previous?.mechanism === 'file' && previous.pid !== holder.pid && isProcessAlive(previous.pid) && !isStale(previous)) {
    closeSync(fd);
    return { acquired: false, holder: previous };
  }
  ftruncateSync(fd, 0);
  writeSync(fd, JSON.stringify({ ...holder, mechanism: 'flock' }), 0);
  return {
    acquired: true,
    lock: {
      mechanism: 'flock',
      // Never unlink an flock'd file: another daemon may already have it open.
      release: () => {
        try {
          ftruncateSync(fd, 0);
        } finally {
          closeSync(fd);
        }
      },
    },
  };
};

// ─── The file-based fallback ────────────────────────────────────────────────

export interface AcquireOptions {
  readonly isStale?: ((holder: LockHolder) => boolean) | undefined;
  readonly now?: number | undefined;
  /** A takeover mutex older than this was left by a daemon that crashed mid-takeover. */
  readonly takeoverStaleMs?: number | undefined;
  /** For tests: act as another process. */
  readonly pid?: number | undefined;
  readonly isAlive?: ((pid: number) => boolean) | undefined;
  /** For tests: runs after a holder is judged stale, before it is replaced. */
  readonly beforeTakeover?: (() => void) | undefined;
  /** For tests: runs while this process holds the takeover mutex. */
  readonly duringTakeover?: (() => void) | undefined;
}

const DEFAULT_TAKEOVER_STALE_MS = 2000;
const RETRY_INTERVAL_MS = 5;

/**
 * Create the lock only if there is none, with its content already in place:
 * written to a private file, then hard-linked to the lock's name (which
 * fails if the name exists). A reader never sees a half-written lock.
 */
const createLock = (path: string, holder: LockHolder): boolean => {
  const temporary = `${path}.${holder.pid}.${randomBytes(4).toString('hex')}`;
  writeFileSync(temporary, JSON.stringify({ ...holder, mechanism: 'file' }), { mode: 0o600, flag: 'wx' });
  try {
    linkSync(temporary, path);
    return true;
  } catch (error) {
    if (isErrno(error, 'EEXIST')) {
      return false;
    }
    throw error;
  } finally {
    unlinkSync(temporary);
  }
};

/** Only one daemon at a time may replace a stale lock; the mutex file holds its token. */
const tryTakeoverMutex = (mutex: string, token: string, staleMs: number): boolean => {
  try {
    writeFileSync(mutex, token, { mode: 0o600, flag: 'wx' });
    return true;
  } catch (error) {
    if (!isErrno(error, 'EEXIST')) {
      throw error;
    }
  }
  try {
    // A holder needs microseconds inside the mutex; one this old crashed there.
    if (Date.now() - statSync(mutex).mtimeMs > staleMs) {
      unlinkSync(mutex);
    }
  } catch {
    // Released meanwhile.
  }
  return false;
};

/** Remove the mutex only while it still holds our token: a peer may have taken over a slow critical section. */
const releaseTakeoverMutex = (mutex: string, token: string): void => {
  try {
    if (readFileSync(mutex, 'utf8') === token) {
      unlinkSync(mutex);
    }
  } catch {
    // Already gone.
  }
};

/**
 * The file-based lock. `isStale` decides about a holder that is still alive
 * (its pid may have been reused by an unrelated process).
 *
 * A stale lock is replaced under a takeover mutex, after reading it again:
 * when several daemons start together, exactly one takes over and the
 * others then find a live holder. They keep trying for longer than a
 * crashed daemon's mutex takes to go stale.
 */
export const acquireLock = (
  path: string,
  {
    isStale = () => false,
    now = Date.now(),
    takeoverStaleMs = DEFAULT_TAKEOVER_STALE_MS,
    pid = process.pid,
    isAlive = isProcessAlive,
    beforeTakeover,
    duringTakeover,
  }: AcquireOptions = {},
): LockResult => {
  const self: LockHolder = { pid, startedAt: now };
  const live = (holder: LockHolder | undefined): holder is LockHolder =>
    holder !== undefined && holder.pid !== pid && isAlive(holder.pid) && !isStale(holder);
  const mutex = `${path}.takeover`;
  const token = `${pid}:${randomBytes(8).toString('hex')}`;
  const deadline = Date.now() + takeoverStaleMs * 2 + 1000;

  do {
    if (createLock(path, self)) {
      return { acquired: true };
    }
    const holder = readLock(path);
    if (live(holder)) {
      return { acquired: false, holder };
    }
    // Stale, unreadable, or ours from an earlier run in this process: replace it.
    beforeTakeover?.();
    if (!tryTakeoverMutex(mutex, token, takeoverStaleMs)) {
      sleepSync(RETRY_INTERVAL_MS);
      continue;
    }
    try {
      duringTakeover?.();
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
      releaseTakeoverMutex(mutex, token);
    }
  } while (Date.now() < deadline);
  const holder = readLock(path);
  return holder ? { acquired: false, holder } : { acquired: false, holder: { pid: 0, startedAt: 0 } };
};

/** Remove the file-based lock if this process still holds it. */
export const releaseLock = (path: string): void => {
  if (readLock(path)?.pid === process.pid) {
    try {
      unlinkSync(path);
    } catch {
      // Already gone.
    }
  }
};

// ─── The daemon's lock ──────────────────────────────────────────────────────

/**
 * Take the daemon lock: flock when node:ffi is there, the file-based lock
 * otherwise (or when `mechanism` says so, for tests).
 */
export const acquireDaemonLock = async (
  path: string,
  options: AcquireOptions & { readonly mechanism?: LockMechanism | 'auto' | undefined } = {},
): Promise<DaemonLockResult> => {
  const holder: LockHolder = { pid: options.pid ?? process.pid, startedAt: options.now ?? Date.now() };
  const flock = options.mechanism === 'file' ? undefined : await loadFlock();
  if (flock) {
    return acquireFlock(path, flock, holder, options.isStale ?? (() => false));
  }
  if (options.mechanism === 'flock') {
    throw new Error('flock is not available: run Node with --experimental-ffi.');
  }
  const result = acquireLock(path, options);
  return result.acquired
    ? { acquired: true, lock: { mechanism: 'file', release: () => releaseLock(path) } }
    : { acquired: false, holder: result.holder };
};

// ─── Taking the lock at startup ─────────────────────────────────────────────

/** A live holder younger than this may still be starting, whatever its socket says. */
export const LOCK_GRACE_MS = 10_000;
/**
 * How long a daemon keeps trying for a lock whose holder serves nothing (it
 * is stopping, or starting). It must cover a stopping daemon: up to 2 s for
 * stuck turns (all at once), then its agents and store, well under 6 s. And
 * it must end clearly before the client that started this daemon gives up
 * (DEFAULT_START_TIMEOUT_MS in client/daemon-spawn.ts, 10 s), leaving this
 * daemon about 4 s to start serving once it has the lock. Shortening this
 * wait, rather than lengthening the client's, keeps a daemon that truly
 * cannot start from making the user wait longer for the error.
 */
export const LOCK_WAIT_MS = 6_000;
/**
 * A holder whose socket has refused connections this long, without a break,
 * is not a daemon any more: its pid was reused. Longer than a daemon takes
 * to stop once it has closed its socket, and shorter than LOCK_WAIT_MS, or
 * no takeover would ever happen.
 */
export const LOCK_ABANDONED_AFTER_MS = 5_000;
const LOCK_RETRY_MS = 50;

export interface TakeDaemonLockOptions extends Omit<AcquireOptions, 'isStale'> {
  readonly mechanism?: LockMechanism | 'auto' | undefined;
  readonly waitMs?: number | undefined;
  readonly abandonedAfterMs?: number | undefined;
  readonly graceMs?: number | undefined;
  readonly retryMs?: number | undefined;
  /** For tests: what the socket says. */
  readonly probe?: ((socketPath: string) => Promise<SocketState>) | undefined;
}

/**
 * Take the daemon lock for a daemon about to serve `socketPath`.
 *
 * A lock that is held while nothing answers on the socket usually belongs
 * to a daemon that is stopping: it closes its socket first and lets go of
 * the lock only once its turns, agents and store are closed. A client that
 * arrives in between starts a new daemon, which must wait for the lock
 * rather than exit, or the client is left with no daemon. So this keeps
 * trying until the lock is free, a daemon answers on the socket (then it
 * gives up: that daemon serves), or `waitMs` passes.
 *
 * A live holder counts as stale (its pid was reused) only when it started
 * long ago and its socket has flatly refused connections for
 * `abandonedAfterMs`: a socket that is merely slow to answer may belong to
 * a busy daemon, which is never taken over.
 */
export const takeDaemonLock = async (
  lockPath: string,
  socketPath: string,
  {
    waitMs = LOCK_WAIT_MS,
    abandonedAfterMs = LOCK_ABANDONED_AFTER_MS,
    graceMs = LOCK_GRACE_MS,
    retryMs = LOCK_RETRY_MS,
    probe = (path) => probeSocketState(path),
    ...options
  }: TakeDaemonLockOptions = {},
): Promise<DaemonLockResult> => {
  const deadline = Date.now() + waitMs;
  let refusedSince: number | undefined;
  const isStale = (holder: LockHolder): boolean =>
    Date.now() - holder.startedAt > graceMs && refusedSince !== undefined && Date.now() - refusedSince >= abandonedAfterMs;
  for (;;) {
    const result = await acquireDaemonLock(lockPath, { ...options, isStale });
    if (result.acquired) {
      return result;
    }
    const state = await probe(socketPath);
    if (state === 'answers' || Date.now() >= deadline) {
      return result;
    }
    refusedSince = state === 'refused' ? (refusedSince ?? Date.now()) : undefined;
    await new Promise((resolve) => setTimeout(resolve, retryMs));
  }
};
