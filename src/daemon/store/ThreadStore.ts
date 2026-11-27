import { chmodSync, closeSync, mkdirSync, openSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import type { ThreadEvent, ThreadLocation, ThreadStatus } from '../../protocol/schema.js';
import { DaemonPaths } from '../DaemonPaths.js';

/*
 * Threads and their events in SQLite (node:sqlite, synchronous). The daemon
 * is the only writer and every statement is small, so calls run inline.
 * A failing statement means a broken database file, which no caller can
 * handle, so it surfaces as a defect rather than a typed error.
 */

export interface ThreadRow {
  readonly id: string;
  readonly title: string;
  readonly agentId: string;
  readonly location: ThreadLocation;
  readonly cwd: string;
  readonly nativeSessionId: string | null;
  /** The shell directory the latest prompt came from. */
  readonly lastShellCwd: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly status: ThreadStatus;
  readonly turnCount: number;
}

export type ThreadPatch = Partial<Omit<ThreadRow, 'id' | 'createdAt'>>;

export class ThreadStore extends Context.Service<
  ThreadStore,
  {
    readonly insertThread: (row: ThreadRow) => Effect.Effect<void>;
    readonly getThread: (id: string) => Effect.Effect<ThreadRow | undefined>;
    /** Most recently updated first. */
    readonly listThreads: (limit: number) => Effect.Effect<readonly ThreadRow[]>;
    readonly updateThread: (id: string, patch: ThreadPatch) => Effect.Effect<void>;
    /** The thread and all its events. */
    readonly deleteThread: (id: string) => Effect.Effect<void>;
    readonly appendEvents: (threadId: string, events: readonly ThreadEvent[]) => Effect.Effect<void>;
    /** 0 when the thread has no events. */
    readonly lastSeq: (threadId: string) => Effect.Effect<number>;
    readonly eventsAfter: (threadId: string, afterSeq: number) => Effect.Effect<readonly ThreadEvent[]>;
    /** The events of the last `turns` turns, and anything between them. */
    readonly history: (threadId: string, turns: number) => Effect.Effect<readonly ThreadEvent[]>;
    /** Merge each message's chunks into one event, once the turn has ended. */
    readonly compactTurn: (threadId: string, turnId: string) => Effect.Effect<void>;
    /**
     * After a restart: end every turn the last daemon lost as `interrupted`
     * and set its thread idle. Returns the ids of the threads it fixed.
     */
    readonly reconcile: (now: number) => Effect.Effect<readonly string[]>;
    readonly schemaVersion: Effect.Effect<number>;
  }
>()('shelly/daemon/ThreadStore') {}

// ─── Schema ─────────────────────────────────────────────────────────────────

/** One entry per schema version; never edit a shipped one, add the next. */
const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE threads (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    location TEXT NOT NULL,
    cwd TEXT NOT NULL,
    native_session_id TEXT,
    last_shell_cwd TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    status TEXT NOT NULL,
    turn_count INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX threads_updated_at ON threads (updated_at DESC);
  CREATE TABLE thread_events (
    thread_id TEXT NOT NULL REFERENCES threads (id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    turn_id TEXT,
    type TEXT NOT NULL,
    payload TEXT NOT NULL,
    PRIMARY KEY (thread_id, seq)
  ) WITHOUT ROWID;
  CREATE INDEX thread_events_turn ON thread_events (thread_id, turn_id, seq);
  `,
];

export const SCHEMA_VERSION = MIGRATIONS.length;

const migrate = (db: DatabaseSync): void => {
  const current = Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
  if (current > MIGRATIONS.length) {
    throw new Error(`The database schema (version ${current}) is newer than this Shelly understands.`);
  }
  for (let version = current; version < MIGRATIONS.length; version++) {
    transaction(db, () => {
      db.exec(MIGRATIONS[version] ?? '');
      db.exec(`PRAGMA user_version = ${version + 1}`);
    });
  }
};

const transaction = <A>(db: DatabaseSync, body: () => A): A => {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = body();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
};

/** Opens (creating if needed) the database with owner-only permissions. */
export const openDatabase = (path: string): DatabaseSync => {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  closeSync(openSync(path, 'a', 0o600));
  chmodSync(path, 0o600);
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 2000');
  migrate(db);
  return db;
};

// ─── Rows ───────────────────────────────────────────────────────────────────

interface ThreadRecord {
  id: string;
  title: string;
  agent_id: string;
  location: string;
  cwd: string;
  native_session_id: string | null;
  last_shell_cwd: string | null;
  created_at: number;
  updated_at: number;
  status: string;
  turn_count: number;
}

const fromRecord = (record: ThreadRecord): ThreadRow => ({
  id: record.id,
  title: record.title,
  agentId: record.agent_id,
  location: record.location as ThreadLocation,
  cwd: record.cwd,
  nativeSessionId: record.native_session_id,
  lastShellCwd: record.last_shell_cwd,
  createdAt: Number(record.created_at),
  updatedAt: Number(record.updated_at),
  status: record.status as ThreadStatus,
  turnCount: Number(record.turn_count),
});

const COLUMNS: Record<keyof ThreadPatch, string> = {
  title: 'title',
  agentId: 'agent_id',
  location: 'location',
  cwd: 'cwd',
  nativeSessionId: 'native_session_id',
  lastShellCwd: 'last_shell_cwd',
  updatedAt: 'updated_at',
  status: 'status',
  turnCount: 'turn_count',
};

const turnIdOf = (event: ThreadEvent): string | null => ('turnId' in event ? event.turnId : null);

const parseEvents = (rows: readonly unknown[]): ThreadEvent[] =>
  rows.map((row) => JSON.parse((row as { payload: string }).payload) as ThreadEvent);

// ─── Implementation ─────────────────────────────────────────────────────────

export const make = (db: DatabaseSync): ThreadStore['Service'] => {
  const statements = {
    insertThread: db.prepare(
      `INSERT INTO threads (id, title, agent_id, location, cwd, native_session_id, last_shell_cwd, created_at, updated_at, status, turn_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    getThread: db.prepare('SELECT * FROM threads WHERE id = ?'),
    listThreads: db.prepare('SELECT * FROM threads ORDER BY updated_at DESC, created_at DESC LIMIT ?'),
    deleteThread: db.prepare('DELETE FROM threads WHERE id = ?'),
    deleteEvents: db.prepare('DELETE FROM thread_events WHERE thread_id = ?'),
    insertEvent: db.prepare('INSERT INTO thread_events (thread_id, seq, turn_id, type, payload) VALUES (?, ?, ?, ?, ?)'),
    lastSeq: db.prepare('SELECT MAX(seq) AS seq FROM thread_events WHERE thread_id = ?'),
    eventsAfter: db.prepare('SELECT payload FROM thread_events WHERE thread_id = ? AND seq > ? ORDER BY seq'),
    nthLastTurnStart: db.prepare(
      `SELECT seq FROM thread_events WHERE thread_id = ? AND type = 'turn.started' ORDER BY seq DESC LIMIT 1 OFFSET ?`,
    ),
    turnEvents: db.prepare('SELECT seq, type, payload FROM thread_events WHERE thread_id = ? AND turn_id = ? ORDER BY seq'),
    updatePayload: db.prepare('UPDATE thread_events SET payload = ? WHERE thread_id = ? AND seq = ?'),
    deleteEvent: db.prepare('DELETE FROM thread_events WHERE thread_id = ? AND seq = ?'),
    lastTurnStart: db.prepare(
      `SELECT payload FROM thread_events WHERE thread_id = ? AND type = 'turn.started' ORDER BY seq DESC LIMIT 1`,
    ),
    busyThreads: db.prepare(`SELECT id FROM threads WHERE status IN ('running', 'waiting')`),
    setIdle: db.prepare(`UPDATE threads SET status = 'idle' WHERE id = ?`),
  };

  const lastSeqSync = (threadId: string): number =>
    Number((statements.lastSeq.get(threadId) as { seq: number | null } | undefined)?.seq ?? 0);

  const appendSync = (threadId: string, events: readonly ThreadEvent[]): void => {
    for (const event of events) {
      statements.insertEvent.run(threadId, event.seq, turnIdOf(event), event.type, JSON.stringify(event));
    }
  };

  const compactSync = (threadId: string, turnId: string): void => {
    const rows = statements.turnEvents.all(threadId, turnId) as { seq: number; type: string; payload: string }[];
    let run: { seq: number; event: Extract<ThreadEvent, { type: 'message.chunk' }> }[] = [];
    const flush = (): void => {
      if (run.length > 1) {
        // The merged event keeps the last chunk's seq, so seqs stay increasing
        // and a watcher resuming inside the message gets all of it.
        const last = run.at(-1)!;
        const text = run.map(({ event }) => event.text).join('');
        statements.updatePayload.run(JSON.stringify({ ...last.event, text }), threadId, last.seq);
        for (const { seq } of run.slice(0, -1)) {
          statements.deleteEvent.run(threadId, seq);
        }
      }
      run = [];
    };
    for (const row of rows) {
      if (row.type !== 'message.chunk') {
        flush();
        continue;
      }
      const event = JSON.parse(row.payload) as Extract<ThreadEvent, { type: 'message.chunk' }>;
      if (run.length > 0 && run[0]!.event.messageId !== event.messageId) {
        flush();
      }
      run.push({ seq: Number(row.seq), event });
    }
    flush();
  };

  const reconcileThreadSync = (threadId: string, now: number): void => {
    const startRow = statements.lastTurnStart.get(threadId) as { payload: string } | undefined;
    if (!startRow) {
      return;
    }
    const started = JSON.parse(startRow.payload) as Extract<ThreadEvent, { type: 'turn.started' }>;
    const events = parseEvents(statements.turnEvents.all(threadId, started.turnId));
    if (events.some((event) => event.type === 'turn.ended')) {
      return;
    }
    let seq = lastSeqSync(threadId);
    const resolved = new Set(events.flatMap((event) => (event.type === 'permission.resolved' ? [event.requestId] : [])));
    const closing: ThreadEvent[] = [];
    for (const event of events) {
      if (event.type === 'permission.requested' && !resolved.has(event.requestId)) {
        closing.push({ seq: ++seq, type: 'permission.resolved', turnId: started.turnId, requestId: event.requestId, optionId: null });
      }
    }
    closing.push({
      seq: ++seq,
      type: 'turn.ended',
      turnId: started.turnId,
      stopReason: 'interrupted',
      error: null,
      durationMs: Math.max(0, now - started.at),
    });
    appendSync(threadId, closing);
    compactSync(threadId, started.turnId);
  };

  return ThreadStore.of({
    insertThread: (row) =>
      Effect.sync(() => {
        statements.insertThread.run(
          row.id, row.title, row.agentId, row.location, row.cwd, row.nativeSessionId, row.lastShellCwd,
          row.createdAt, row.updatedAt, row.status, row.turnCount,
        );
      }),
    getThread: (id) =>
      Effect.sync(() => {
        const record = statements.getThread.get(id) as ThreadRecord | undefined;
        return record ? fromRecord(record) : undefined;
      }),
    listThreads: (limit) =>
      Effect.sync(() => (statements.listThreads.all(Math.max(0, Math.floor(limit))) as unknown as ThreadRecord[]).map(fromRecord)),
    updateThread: (id, patch) =>
      Effect.sync(() => {
        const entries = Object.entries(patch).filter(([, value]) => value !== undefined) as [keyof ThreadPatch, SQLInputValue][];
        if (entries.length === 0) {
          return;
        }
        const sets = entries.map(([key]) => `${COLUMNS[key]} = ?`).join(', ');
        db.prepare(`UPDATE threads SET ${sets} WHERE id = ?`).run(...entries.map(([, value]) => value), id);
      }),
    deleteThread: (id) =>
      Effect.sync(() =>
        transaction(db, () => {
          statements.deleteEvents.run(id);
          statements.deleteThread.run(id);
        })
      ),
    appendEvents: (threadId, events) => Effect.sync(() => transaction(db, () => appendSync(threadId, events))),
    lastSeq: (threadId) => Effect.sync(() => lastSeqSync(threadId)),
    eventsAfter: (threadId, afterSeq) => Effect.sync(() => parseEvents(statements.eventsAfter.all(threadId, afterSeq))),
    history: (threadId, turns) =>
      Effect.sync(() => {
        if (turns <= 0) {
          return [];
        }
        const start = statements.nthLastTurnStart.get(threadId, Math.floor(turns) - 1) as { seq: number } | undefined;
        return parseEvents(statements.eventsAfter.all(threadId, start ? Number(start.seq) - 1 : 0));
      }),
    compactTurn: (threadId, turnId) => Effect.sync(() => transaction(db, () => compactSync(threadId, turnId))),
    reconcile: (now) =>
      Effect.sync(() =>
        transaction(db, () => {
          const ids = (statements.busyThreads.all() as { id: string }[]).map((row) => row.id);
          for (const id of ids) {
            reconcileThreadSync(id, now);
            statements.setIdle.run(id);
          }
          return ids;
        })
      ),
    schemaVersion: Effect.sync(() => Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version)),
  });
};

/** The store over `$SHELLY_HOME/state.sqlite`, closed with the layer. */
export const layer: Layer.Layer<ThreadStore, never, DaemonPaths> = Layer.effect(
  ThreadStore,
  Effect.gen(function* () {
    const paths = yield* DaemonPaths;
    const db = yield* Effect.acquireRelease(
      Effect.sync(() => openDatabase(paths.database)),
      (db) => Effect.sync(() => db.close()),
    );
    return make(db);
  }),
);
