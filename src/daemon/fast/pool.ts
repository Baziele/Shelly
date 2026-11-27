import { type FastBackend, type FastWorker, isWorkerFailure, type Turn, type TurnHandlers } from './worker.js';

/*
 * Which fast-mode workers exist, and for how long. Each costs about 200 MB,
 * so the rules are tight:
 *
 * - Per agent, at most one idle warm worker. It is kept only within the
 *   keep-warm window after the last request or prewarm.
 * - A request takes the warm worker (or starts one cold) and, right away,
 *   starts its replacement in the background.
 * - The worker a request took belongs to that request's session key from
 *   then on, so follow-ups keep their context. It is killed after the
 *   session's idle time, or when the session ends.
 * - At most `maxSessions` conversations keep a worker; a new one ends the
 *   least recently used idle one.
 * - A turn that does not finish (cancelled, or replaced by a newer request
 *   on the same key) ends its conversation: the worker would keep the half
 *   turn in its context and answer the next request about it. The next
 *   request takes the warm worker, so this costs no latency.
 */

export interface PoolTimings {
  /** How long after a request or prewarm an idle warm worker is kept. */
  readonly keepWarmMs: number;
  /** How long a conversation's worker lives after its last request. */
  readonly sessionIdleMs: number;
  /** How many conversations may keep a worker at once. */
  readonly maxSessions: number;
  /** A monotonic clock in ms; tests pass their own. */
  readonly now?: () => number;
}

interface AgentPool {
  backend: FastBackend;
  warm: FastWorker | null;
  /** When the last request or prewarm for this agent happened. */
  lastUsedAt: number;
  expiry: NodeJS.Timeout | undefined;
}

interface Session {
  readonly agentId: string;
  readonly backendKey: string;
  readonly worker: FastWorker;
  turn: Turn | null;
  idle: NodeJS.Timeout | undefined;
}

export class FastPool {
  private readonly agents = new Map<string, AgentPool>();
  private readonly sessions = new Map<string, Session>();
  /** Every worker started and not yet exited, for the count and for shutdown. */
  private readonly live = new Set<FastWorker>();
  private closed = false;

  private readonly now: () => number;

  constructor(private readonly timings: PoolTimings) {
    this.now = timings.now ?? (() => performance.now());
  }

  get workerCount(): number {
    return this.live.size;
  }

  /** Have a warm worker ready for the agent. Failures (not installed) wait for a request to report them. */
  prewarm(agentId: string, backend: FastBackend): void {
    if (this.closed) return;
    const pool = this.pool(agentId, backend);
    this.touch(pool);
    this.ensureWarm(pool);
  }

  /**
   * Run one request in the session's conversation. Returns the turn, or
   * calls `onFailure` (soon, never synchronously) when no worker can start.
   */
  request(agentId: string, backend: FastBackend, sessionKey: string, message: string, handlers: TurnHandlers): Turn {
    if (this.closed) {
      queueMicrotask(() => handlers.onFailure({ kind: 'failed', reason: 'Shelly is shutting down.' }));
      return { cancel: () => {} };
    }
    const pool = this.pool(agentId, backend);
    this.touch(pool);

    let session = this.sessions.get(sessionKey);
    // A running turn is replaced: its conversation goes with it, and its request fails.
    if (session && (session.turn !== null || !session.worker.alive || session.agentId !== agentId || session.backendKey !== backend.key)) {
      this.end(sessionKey);
      session = undefined;
    }

    if (!session) {
      let worker = pool.warm;
      pool.warm = null;
      if (!worker?.alive) {
        const spawned = this.spawn(pool);
        if (isWorkerFailure(spawned)) {
          queueMicrotask(() => handlers.onFailure(spawned));
          return { cancel: () => {} };
        }
        worker = spawned;
      }
      session = { agentId, backendKey: backend.key, worker, turn: null, idle: undefined };
      this.evictIdleSessions(this.timings.maxSessions - 1);
      this.sessions.set(sessionKey, session);
    }
    // The replacement starts while this request runs, so the next new conversation is warm too.
    this.ensureWarm(pool);

    const owner = session;
    clearTimeout(owner.idle);
    // Most recently used last, for eviction.
    this.sessions.delete(sessionKey);
    this.sessions.set(sessionKey, owner);
    const settle = () => {
      if (owner.turn !== turn) return;
      owner.turn = null;
      this.armSessionIdle(sessionKey, owner);
    };
    const turn: Turn = owner.worker.send(message, {
      onDelta: handlers.onDelta,
      onDone: (text) => {
        settle();
        handlers.onDone(text);
      },
      onFailure: (failure) => {
        settle();
        // A worker that can't sign in is no use, and neither is its warm sibling: let a sign-in take effect.
        if (failure.kind === 'unavailable') this.dropWarm(pool);
        handlers.onFailure(failure);
      },
    });
    owner.turn = turn;
    return {
      cancel: () => {
        if (owner.turn !== turn) return;
        turn.cancel();
        settle();
        if (this.sessions.get(sessionKey) === owner) this.end(sessionKey);
        else owner.worker.kill();
      },
    };
  }

  end(sessionKey: string): void {
    const session = this.sessions.get(sessionKey);
    if (!session) return;
    this.sessions.delete(sessionKey);
    clearTimeout(session.idle);
    session.worker.kill();
  }

  /** Kill every worker and wait for them to exit. */
  async close(): Promise<void> {
    this.closed = true;
    for (const key of [...this.sessions.keys()]) this.end(key);
    for (const pool of this.agents.values()) {
      clearTimeout(pool.expiry);
      this.dropWarm(pool);
    }
    const workers = [...this.live];
    for (const worker of workers) worker.kill();
    await Promise.all(workers.map((worker) => worker.exited));
  }

  // ─── Internals ──────────────────────────────────────────────────────────

  private pool(agentId: string, backend: FastBackend): AgentPool {
    let pool = this.agents.get(agentId);
    if (!pool) {
      pool = { backend, warm: null, lastUsedAt: 0, expiry: undefined };
      this.agents.set(agentId, pool);
    } else if (pool.backend.key !== backend.key) {
      // The config changed (another model, say): the warm worker runs the old one.
      this.dropWarm(pool);
      pool.backend = backend;
    }
    return pool;
  }

  private touch(pool: AgentPool): void {
    pool.lastUsedAt = this.now();
    this.armExpiry(pool, this.timings.keepWarmMs);
  }

  private armExpiry(pool: AgentPool, delayMs: number): void {
    clearTimeout(pool.expiry);
    pool.expiry = setTimeout(() => this.expire(pool), delayMs);
    pool.expiry.unref();
  }

  private expire(pool: AgentPool): void {
    const remaining = this.timings.keepWarmMs - (this.now() - pool.lastUsedAt);
    // A timer can fire a little before the clock says the window is over: wait out the rest.
    if (remaining > 0) {
      this.armExpiry(pool, remaining);
      return;
    }
    this.dropWarm(pool);
  }

  private ensureWarm(pool: AgentPool): void {
    if (this.closed || pool.warm?.alive) return;
    if (this.now() - pool.lastUsedAt >= this.timings.keepWarmMs) return;
    const spawned = this.spawn(pool);
    pool.warm = isWorkerFailure(spawned) ? null : spawned;
  }

  private dropWarm(pool: AgentPool): void {
    pool.warm?.kill();
    pool.warm = null;
  }

  private spawn(pool: AgentPool) {
    const spawned = pool.backend.spawn();
    if (isWorkerFailure(spawned)) return spawned;
    this.live.add(spawned);
    void spawned.exited.then(() => {
      this.live.delete(spawned);
      if (pool.warm === spawned) pool.warm = null;
    });
    return spawned;
  }

  /** End the least recently used idle conversations until at most `keep` remain. */
  private evictIdleSessions(keep: number): void {
    for (const [key, session] of this.sessions) {
      if (this.sessions.size <= keep) return;
      if (session.turn === null) this.end(key);
    }
  }

  private armSessionIdle(sessionKey: string, session: Session): void {
    clearTimeout(session.idle);
    if (!session.worker.alive) {
      if (this.sessions.get(sessionKey) === session) this.sessions.delete(sessionKey);
      return;
    }
    session.idle = setTimeout(() => {
      if (this.sessions.get(sessionKey) === session && session.turn === null) this.end(sessionKey);
    }, this.timings.sessionIdleMs);
    session.idle.unref();
  }
}
