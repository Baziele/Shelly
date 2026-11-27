import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as Schema from 'effect/Schema';
import { DaemonRpcs } from './rpc.js';
import { FastEvent, PromptContext, ThreadEvent, type ThreadEvent as ThreadEventType } from './schema.js';

/** Through JSON and back, as the socket carries it. */
const roundTrip = <S extends Schema.Codec<unknown, unknown>>(schema: S, value: S['Type']): unknown =>
  Schema.decodeUnknownSync(schema)(JSON.parse(JSON.stringify(Schema.encodeSync(schema)(value))));

const EVENTS: ThreadEventType[] = [
  { seq: 1, type: 'turn.started', turnId: 't1', text: 'why did the build fail', at: 1 },
  { seq: 2, type: 'message.chunk', turnId: 't1', messageId: 'm1', kind: 'thought', text: 'Looking' },
  {
    seq: 3,
    type: 'tool.updated',
    turnId: 't1',
    tool: {
      id: 'tool-1',
      title: 'Edit src/a.ts',
      kind: 'edit',
      status: 'completed',
      locations: [{ path: 'src/a.ts', line: 3 }],
      content: [
        { type: 'diff', path: 'src/a.ts', oldText: null, newText: 'export {}', truncated: false },
        { type: 'text', text: 'ok', truncated: true },
      ],
    },
  },
  { seq: 4, type: 'plan.updated', turnId: 't1', entries: [{ content: 'Fix it', priority: 'high', status: 'in_progress' }] },
  {
    seq: 5,
    type: 'permission.requested',
    turnId: 't1',
    requestId: 'r1',
    toolCallId: 'tool-1',
    title: 'Run npm test',
    options: [{ optionId: 'allow', name: 'Allow once', kind: 'allow_once' }],
  },
  { seq: 6, type: 'permission.resolved', turnId: 't1', requestId: 'r1', optionId: null },
  { seq: 7, type: 'mode.changed', currentModeId: 'plan', availableModes: [{ id: 'plan', name: 'Plan', description: null }] },
  { seq: 8, type: 'notice', turnId: null, level: 'warning', text: 'Resumed a new session' },
  { seq: 9, type: 'turn.ended', turnId: 't1', stopReason: 'cancelled', error: null, durationMs: 1200 },
];

describe('protocol schemas', () => {
  it('carries every thread event through JSON unchanged', () => {
    for (const event of EVENTS) {
      assert.deepEqual(roundTrip(ThreadEvent, event), event, event.type);
    }
  });

  it('rejects an event of an unknown type', () => {
    assert.throws(() => Schema.decodeUnknownSync(ThreadEvent)({ seq: 1, type: 'turn.exploded', turnId: 't' }));
  });

  it('carries prompt context and fast replies', () => {
    const context: PromptContext = {
      cwd: '/repo',
      environment: { os: 'macOS', shell: 'zsh', shellVersion: 'zsh 5.9', terminal: null },
      commands: [{ id: 1, command: 'npm test', cwd: '/repo', exitCode: 1, durationMs: 900, output: 'FAIL', omittedLines: 0, usedFullScreen: false }],
    };
    assert.deepEqual(roundTrip(PromptContext, context), context);
    const done: FastEvent = { type: 'done', text: 'ls -la', kind: 'command', durationMs: 700 };
    assert.deepEqual(roundTrip(FastEvent, done), done);
  });

  it('names every RPC the daemon serves', () => {
    assert.deepEqual([...DaemonRpcs.requests.keys()].sort(), [
      'agents.list', 'agents.setDefault', 'daemon.shutdown', 'daemon.status', 'fast.end', 'fast.prewarm',
      'fast.request', 'hello', 'thread.attach', 'thread.cancel', 'thread.create', 'thread.delete',
      'thread.detach', 'thread.list', 'thread.prewarm', 'thread.prompt', 'thread.rename', 'thread.respond',
      'thread.setMode', 'thread.watch',
    ]);
  });
});
