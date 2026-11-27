import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import * as Effect from 'effect/Effect';
import type { ThreadEvent } from '../../protocol/schema.js';
import { make, openDatabase, SCHEMA_VERSION, type ThreadRow } from './ThreadStore.js';

const dirs: string[] = [];
after(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const openStore = () => {
  const dir = mkdtempSync(join(tmpdir(), 'shelly-store-'));
  dirs.push(dir);
  const path = join(dir, 'state.sqlite');
  const db = openDatabase(path);
  return { db, path, store: make(db) };
};

const run = Effect.runSync;

const THREAD: ThreadRow = {
  id: 'th1',
  title: '',
  agentId: 'claude',
  location: 'home',
  cwd: '/shelly/home',
  nativeSessionId: null,
  lastShellCwd: '/work',
  createdAt: 1,
  updatedAt: 1,
  status: 'idle',
  turnCount: 0,
};

const turn = (first: number, turnId: string, chunks: string[]): ThreadEvent[] => [
  { seq: first, type: 'turn.started', turnId, text: 'q', at: 100 },
  ...chunks.map((text, index): ThreadEvent => ({ seq: first + 1 + index, type: 'message.chunk', turnId, messageId: `${turnId}-m1`, kind: 'text', text })),
  { seq: first + 1 + chunks.length, type: 'turn.ended', turnId, stopReason: 'end_turn', error: null, durationMs: 5 },
];

describe('ThreadStore', () => {
  it('migrates a new database to the current version with owner-only permissions', () => {
    const { db, path, store } = openStore();
    assert.equal(run(store.schemaVersion), SCHEMA_VERSION);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal((db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode, 'wal');
    db.close();
    // Reopening runs no migration twice.
    const again = openDatabase(path);
    assert.equal(run(make(again).schemaVersion), SCHEMA_VERSION);
    again.close();
  });

  it('stores, lists, updates and deletes threads', () => {
    const { store } = openStore();
    run(store.insertThread(THREAD));
    run(store.insertThread({ ...THREAD, id: 'th2', updatedAt: 5 }));
    assert.deepEqual(run(store.listThreads(10)).map((row) => row.id), ['th2', 'th1']);
    run(store.updateThread('th1', { title: 'Fix the build', updatedAt: 9, nativeSessionId: 'native-1' }));
    assert.deepEqual(run(store.getThread('th1')), { ...THREAD, title: 'Fix the build', updatedAt: 9, nativeSessionId: 'native-1' });
    assert.deepEqual(run(store.listThreads(1)).map((row) => row.id), ['th1']);
    run(store.appendEvents('th1', turn(1, 't1', ['a'])));
    run(store.deleteThread('th1'));
    assert.equal(run(store.getThread('th1')), undefined);
    assert.equal(run(store.lastSeq('th1')), 0);
  });

  it('merges each message\'s chunks into one event once the turn ends', () => {
    const { store } = openStore();
    run(store.insertThread(THREAD));
    const events: ThreadEvent[] = [
      { seq: 1, type: 'turn.started', turnId: 't1', text: 'q', at: 100 },
      { seq: 2, type: 'message.chunk', turnId: 't1', messageId: 'm1', kind: 'thought', text: 'Let me ' },
      { seq: 3, type: 'message.chunk', turnId: 't1', messageId: 'm1', kind: 'thought', text: 'look.' },
      { seq: 4, type: 'message.chunk', turnId: 't1', messageId: 'm2', kind: 'text', text: 'It ' },
      { seq: 5, type: 'message.chunk', turnId: 't1', messageId: 'm2', kind: 'text', text: 'failed ' },
      { seq: 6, type: 'message.chunk', turnId: 't1', messageId: 'm2', kind: 'text', text: 'because' },
      { seq: 7, type: 'plan.updated', turnId: 't1', entries: [] },
      { seq: 8, type: 'message.chunk', turnId: 't1', messageId: 'm3', kind: 'text', text: 'Done.' },
      { seq: 9, type: 'turn.ended', turnId: 't1', stopReason: 'end_turn', error: null, durationMs: 5 },
    ];
    run(store.appendEvents('th1', events));
    run(store.compactTurn('th1', 't1'));
    const compacted = run(store.eventsAfter('th1', 0));
    assert.deepEqual(compacted.map((event) => [event.seq, event.type, event.type === 'message.chunk' ? event.text : null]), [
      [1, 'turn.started', null],
      [3, 'message.chunk', 'Let me look.'],
      [6, 'message.chunk', 'It failed because'],
      [7, 'plan.updated', null],
      [8, 'message.chunk', 'Done.'],
      [9, 'turn.ended', null],
    ]);
    // A merged chunk is the whole message: a client that saw part of it replaces that part.
    assert.deepEqual(compacted.flatMap((event) => (event.type === 'message.chunk' ? [[event.seq, event.replace]] : [])), [
      [3, true],
      [6, true],
      [8, undefined],
    ]);
    assert.equal(run(store.lastSeq('th1')), 9);
  });

  it('returns the events of the last N turns', () => {
    const { store } = openStore();
    run(store.insertThread(THREAD));
    run(store.appendEvents('th1', [...turn(1, 't1', ['a']), ...turn(4, 't2', ['b']), ...turn(7, 't3', ['c'])]));
    assert.deepEqual(run(store.history('th1', 2)).map((event) => event.seq), [4, 5, 6, 7, 8, 9]);
    assert.deepEqual(run(store.history('th1', 10)).map((event) => event.seq), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
    assert.deepEqual(run(store.history('th1', 0)), []);
    assert.deepEqual(run(store.eventsAfter('th1', 7)).map((event) => event.seq), [8, 9]);
  });

  it('ends turns a previous daemon lost and sets their threads idle', () => {
    const { store } = openStore();
    run(store.insertThread({ ...THREAD, status: 'waiting' }));
    run(store.insertThread({ ...THREAD, id: 'th2', status: 'idle' }));
    run(store.appendEvents('th1', [
      ...turn(1, 't1', ['done']),
      { seq: 4, type: 'turn.started', turnId: 't2', text: 'q', at: 1000 },
      { seq: 5, type: 'message.chunk', turnId: 't2', messageId: 'm', kind: 'text', text: 'part ' },
      { seq: 6, type: 'message.chunk', turnId: 't2', messageId: 'm', kind: 'text', text: 'two' },
      { seq: 7, type: 'permission.requested', turnId: 't2', requestId: 'r1', toolCallId: null, title: 'Run it?', options: [] },
    ]));

    assert.deepEqual(run(store.reconcile(4000)), ['th1']);
    assert.equal(run(store.getThread('th1'))?.status, 'idle');
    assert.deepEqual(run(store.eventsAfter('th1', 3)), [
      { seq: 4, type: 'turn.started', turnId: 't2', text: 'q', at: 1000 },
      { seq: 6, type: 'message.chunk', turnId: 't2', messageId: 'm', kind: 'text', text: 'part two', replace: true },
      { seq: 7, type: 'permission.requested', turnId: 't2', requestId: 'r1', toolCallId: null, title: 'Run it?', options: [] },
      { seq: 8, type: 'permission.resolved', turnId: 't2', requestId: 'r1', optionId: null },
      { seq: 9, type: 'turn.ended', turnId: 't2', stopReason: 'interrupted', error: null, durationMs: 3000 },
    ]);
    assert.deepEqual(run(store.reconcile(5000)), [], 'nothing left to fix');
  });
});
