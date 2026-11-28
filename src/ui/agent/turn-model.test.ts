import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ThreadEvent, ToolCall } from '../../protocol/schema.js';
import { hasGapBefore, TurnModel, type Phase } from './turn-model.js';

/** Read through a function: assert/strict narrows a getter's value after one check. */
const phaseOf = (model: TurnModel): Phase => model.phase;

let seq = 0;
const ev = <T extends ThreadEvent['type']>(event: Omit<Extract<ThreadEvent, { type: T }>, 'seq'>): ThreadEvent =>
  ({ ...event, seq: ++seq }) as unknown as ThreadEvent;
const text = (messageId: string, chunk: string, kind: 'text' | 'thought' = 'text') =>
  ev<'message.chunk'>({ type: 'message.chunk', turnId: 't', messageId, kind, text: chunk });
/** A chunk merged after its turn ended: the message's whole text. */
const whole = (messageId: string, chunk: string, kind: 'text' | 'thought' = 'text') =>
  ev<'message.chunk'>({ type: 'message.chunk', turnId: 't', messageId, kind, text: chunk, replace: true });
const tool = (id: string, status: ToolCall['status'], title = `tool ${id}`) =>
  ev<'tool.updated'>({ type: 'tool.updated', turnId: 't', tool: { id, title, kind: 'execute', status, locations: [], content: [] } });
const options = [
  { optionId: 'yes', name: 'Allow once', kind: 'allow_once' as const },
  { optionId: 'no', name: 'Reject', kind: 'reject_once' as const },
];
const ask = (requestId: string, toolCallId: string | null = null) =>
  ev<'permission.requested'>({ type: 'permission.requested', turnId: 't', requestId, toolCallId, title: `do ${requestId}`, options });
const end = (stopReason: 'end_turn' | 'cancelled' = 'end_turn') =>
  ev<'turn.ended'>({ type: 'turn.ended', turnId: 't', stopReason, error: null, durationMs: 1000 });
const kinds = (model: TurnModel) => model.blocks.map((block) => (block.kind === 'line' ? block.content.type : block.kind));

describe('TurnModel', () => {
  it('appends chunks of one message and finalizes it when something else starts', () => {
    const model = new TurnModel();
    model.apply(text('m1', 'Hello '));
    model.apply(text('m1', 'world'));
    assert.equal(model.blocks.length, 1);
    assert.equal(model.stablePrefixEnd, 0, 'a streaming message is not final');

    model.apply(tool('a', 'in_progress'));
    const [message] = model.blocks;
    assert.equal(message?.kind === 'message' && message.text, 'Hello world');
    assert.equal(model.stablePrefixEnd, 1, 'the message is final once a tool starts');
  });

  it('commits in order: a finished tool waits for a running one before it', () => {
    const model = new TurnModel();
    model.apply(tool('a', 'in_progress'));
    model.apply(tool('b', 'completed'));
    assert.equal(model.stablePrefixEnd, 0);
    model.apply(tool('a', 'completed'));
    assert.equal(model.stablePrefixEnd, 2);
    model.markCommitted(2);
    assert.equal(model.stablePrefixEnd, 2);
  });

  it('ignores updates to tools already in scrollback', () => {
    const model = new TurnModel();
    model.apply(tool('a', 'completed'));
    model.markCommitted(1);
    model.apply(tool('a', 'failed'));
    const [block] = model.blocks;
    assert.equal(block?.kind === 'tool' && block.tool.status, 'completed');
  });

  it('keeps thoughts live only, and drops them once text arrives', () => {
    const model = new TurnModel();
    model.apply(ev<'turn.started'>({ type: 'turn.started', turnId: 't', text: 'q', at: 0 }));
    model.apply(text('th', 'Looking at ', 'thought'));
    model.apply(text('th', 'the logs', 'thought'));
    assert.equal(model.thought, 'Looking at the logs');
    assert.equal(model.blocks.length, 0);
    assert.equal(phaseOf(model).type, 'thinking');

    model.apply(text('m1', 'Found it'));
    assert.equal(model.thought, undefined);
    assert.equal(phaseOf(model).type, 'writing');
  });

  it('shows phases: starting, running a tool, waiting, stopping', () => {
    const model = new TurnModel();
    assert.equal(phaseOf(model).type, 'starting');
    model.apply(ev<'turn.started'>({ type: 'turn.started', turnId: 't', text: 'q', at: 0 }));
    assert.equal(phaseOf(model).type, 'thinking');
    model.apply(tool('a', 'in_progress', 'pnpm test'));
    const phase = phaseOf(model);
    assert.equal(phase.type === 'running' && phase.tool.title, 'pnpm test');
    model.apply(ask('p1'));
    assert.equal(phaseOf(model).type, 'waiting');
    model.stopping = true;
    assert.equal(phaseOf(model).type, 'stopping');
  });

  it('queues permission requests and shows the oldest first', () => {
    const model = new TurnModel();
    model.apply(ask('p1'));
    model.apply(ask('p2'));
    model.apply(ask('p1'));
    assert.deepEqual(model.permissions.map((request) => request.requestId), ['p1', 'p2']);
  });

  it('folds an answer into the tool it was about', () => {
    const model = new TurnModel();
    model.apply(tool('a', 'pending'));
    model.apply(ask('p1', 'a'));
    model.answer('p1', 'yes');
    assert.equal(model.permissions.length, 0);
    const [block] = model.blocks;
    assert.equal(block?.kind === 'tool' && block.permission, 'allow_once');

    // The daemon's echo of this client's own answer changes nothing.
    model.apply(ev<'permission.resolved'>({ type: 'permission.resolved', turnId: 't', requestId: 'p1', optionId: 'no' }));
    const [after] = model.blocks;
    assert.equal(after?.kind === 'tool' && after.permission, 'allow_once');
  });

  it('records an answer given elsewhere, or a cancelled prompt, as a line when no tool is on screen', () => {
    const model = new TurnModel();
    model.apply(ask('p1'));
    model.apply(ev<'permission.resolved'>({ type: 'permission.resolved', turnId: 't', requestId: 'p1', optionId: 'no' }));
    model.apply(ask('p2'));
    model.apply(end('cancelled'));
    const outcomes = model.blocks.flatMap((block) =>
      block.kind === 'line' && block.content.type === 'permission' ? [block.content.outcome] : []);
    assert.deepEqual(outcomes, ['reject_once', null]);
  });

  it('ends a turn: unfinished tools stop, the plan and a summary are appended, everything is final', () => {
    const model = new TurnModel();
    model.apply(text('m1', 'Working'));
    model.apply(tool('a', 'in_progress'));
    model.apply(ev<'plan.updated'>({ type: 'plan.updated', turnId: 't', entries: [{ content: 'step', priority: 'high', status: 'completed' }] }));
    model.apply(end());
    assert.deepEqual(kinds(model), ['message', 'tool', 'plan', 'summary']);
    assert.equal(model.stablePrefixEnd, 4);
    const toolBlock = model.blocks[1];
    assert.equal(toolBlock?.kind === 'tool' && toolBlock.stopped, true);
    assert.equal(phaseOf(model).type, 'ended');
    assert.equal(model.plan, undefined);
  });

  it('replaces what it has of a message with a `replace` chunk, as a watch resumed after compaction sends', () => {
    const model = new TurnModel();
    model.apply(text('m1', 'Hel'));
    model.apply(whole('m1', 'Hello'));
    model.apply(text('m1', ' there'));
    assert.equal(model.blocks.length, 1);
    const [message] = model.blocks;
    assert.equal(message?.kind === 'message' && message.text, 'Hello there');

    model.apply(text('m2', 'Hmm', 'thought'));
    model.apply(whole('m2', 'Hmm, right', 'thought'));
    assert.equal(model.thought, 'Hmm, right');
  });

  it('shows only the rest of a replaced message whose start is already in scrollback', () => {
    const model = new TurnModel();
    model.apply(text('m1', 'Hel'));
    model.apply(tool('a', 'completed'));
    model.markCommitted(2);
    model.apply(whole('m1', 'Hello'));
    const shown = model.blocks.flatMap((block) => (block.kind === 'message' ? [block.text] : []));
    assert.deepEqual(shown, ['Hel', 'lo']);
  });

  it('counts each tool once', () => {
    const model = new TurnModel();
    model.apply(tool('a', 'pending'));
    model.apply(tool('a', 'in_progress'));
    model.apply(tool('b', 'completed'));
    assert.equal(model.toolCount, 2);
  });
});

describe('TurnModel at the end of a turn', () => {
  it('puts the plan before the closing message, so the conclusion comes after its checklist', () => {
    const model = new TurnModel();
    model.apply(ev<'plan.updated'>({ type: 'plan.updated', turnId: 't', entries: [{ content: 'step', priority: 'high', status: 'completed' }] }));
    model.apply(tool('a', 'completed'));
    model.markCommitted(1);
    model.apply(text('m1', 'All done: here is what changed.'));
    model.apply(end());
    assert.deepEqual(kinds(model).slice(1), ['plan', 'message', 'summary']);
  });

  it('records whether the turn showed anything, for the footer', () => {
    const empty = new TurnModel();
    empty.apply(ev<'notice'>({ type: 'notice', turnId: 't', level: 'warning', text: 'no reply' }));
    empty.apply(end());
    const summary = empty.blocks.at(-1);
    assert.ok(summary?.kind === 'line' && summary.content.type === 'summary');
    assert.equal(summary.content.type === 'summary' && summary.content.produced, false);
    assert.equal(summary.content.type === 'summary' && summary.content.noticed, true);
  });
});

describe('hasGapBefore', () => {
  it('sets prose apart from tool rows, keeps tool rows together', () => {
    const model = new TurnModel();
    model.apply(text('m1', 'Hi'));
    model.apply(tool('a', 'completed'));
    model.apply(tool('b', 'completed'));
    model.apply(text('m2', 'Done'));
    model.apply(end());
    const gaps = model.blocks.map((block, index) => hasGapBefore(model.blocks[index - 1], block));
    assert.deepEqual(gaps, [false, true, false, true, true]);
  });
});
