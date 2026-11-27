import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  mapPermissionOptions,
  mapSessionUpdate,
  mapStopReason,
  mapToolContent,
  modesFromSession,
  ToolTracker,
  truncateDiff,
  truncateText,
} from './mapping.js';

describe('truncation', () => {
  it('keeps the end of long text', () => {
    assert.deepEqual(truncateText('short'), { text: 'short', truncated: false });
    const long = 'a'.repeat(10_000) + 'END';
    const cut = truncateText(long);
    assert.equal(cut.truncated, true);
    assert.equal(cut.text.length, 8 * 1024);
    assert.ok(cut.text.endsWith('END'));
  });

  it('keeps the changed region of a long diff, with context', () => {
    const lines = Array.from({ length: 1_000 }, (_, i) => `line ${i}`);
    const changed = [...lines];
    changed[600] = 'line 600 changed';
    const cut = truncateDiff(lines.join('\n'), changed.join('\n'));
    assert.equal(cut.truncated, true);
    assert.deepEqual(cut.oldText?.split('\n'), lines.slice(597, 604));
    assert.deepEqual(cut.newText.split('\n'), changed.slice(597, 604));
  });

  it('caps each side of a long new file at 200 lines', () => {
    const file = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n');
    const cut = truncateDiff(null, file);
    assert.equal(cut.oldText, null);
    assert.equal(cut.newText.split('\n').length, 200);
    assert.equal(cut.truncated, true);
    assert.deepEqual(truncateDiff('a', 'b'), { oldText: 'a', newText: 'b', truncated: false });
  });
});

describe('tool calls', () => {
  it('merges updates into the whole state', () => {
    const tools = new ToolTracker();
    tools.apply({ toolCallId: 't', title: 'Read File', kind: 'read', status: 'pending', content: [], locations: [] });
    tools.apply({ toolCallId: 't', title: 'Read hello.txt', locations: [{ path: '/p/hello.txt', line: 1 }] });
    const done = tools.apply({
      toolCallId: 't',
      status: 'completed',
      content: [
        { type: 'content', content: { type: 'text', text: 'hi' } },
        { type: 'content', content: { type: 'image', data: '', mimeType: 'image/png' } },
        { type: 'terminal', terminalId: 'x' },
      ],
    });
    assert.deepEqual(done, {
      id: 't',
      title: 'Read hello.txt',
      kind: 'read',
      status: 'completed',
      locations: [{ path: '/p/hello.txt', line: 1 }],
      content: [{ type: 'text', text: 'hi', truncated: false }],
    });
  });

  it('starts from defaults for an update it has not seen, and maps unknown kinds to other', () => {
    const tool = new ToolTracker().apply({ toolCallId: 'x', name: 'write', kind: 'teleport' as never });
    assert.deepEqual(tool, { id: 'x', title: 'write', kind: 'other', status: 'pending', locations: [], content: [] });
  });

  it('maps diffs', () => {
    assert.deepEqual(mapToolContent({ type: 'diff', path: '/a', oldText: null, newText: 'hi' }), {
      type: 'diff', path: '/a', oldText: null, newText: 'hi', truncated: false,
    });
  });
});

describe('session updates', () => {
  const tools = new ToolTracker();

  it('maps chunks, titles, plans and notices', () => {
    assert.deepEqual(mapSessionUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } }, tools), {
      kind: 'update', update: { type: 'chunk', kind: 'text', text: 'hi' },
    });
    assert.deepEqual(mapSessionUpdate({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'hm' } }, tools), {
      kind: 'update', update: { type: 'chunk', kind: 'thought', text: 'hm' },
    });
    assert.deepEqual(mapSessionUpdate({ sessionUpdate: 'session_info_update', title: ' Fix the build ' }, tools), {
      kind: 'update', update: { type: 'title', title: 'Fix the build' },
    });
    assert.deepEqual(mapSessionUpdate({ sessionUpdate: 'plan', entries: [{ content: 'a', priority: 'low', status: 'completed' }] }, tools), {
      kind: 'update', update: { type: 'plan', entries: [{ content: 'a', priority: 'low', status: 'completed' }] },
    });
    assert.deepEqual(mapSessionUpdate({ sessionUpdate: 'notice', severity: 'warning', title: 'Heads up', description: 'details' }, tools), {
      kind: 'update', update: { type: 'notice', level: 'warning', text: 'Heads up: details' },
    });
  });

  it('ignores our own prompt, commands and usage', () => {
    for (const update of [
      { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'me' } },
      { sessionUpdate: 'available_commands_update', availableCommands: [] },
      { sessionUpdate: 'usage_update', used: 1, size: 2 },
      { sessionUpdate: 'session_info_update', title: null },
      { sessionUpdate: '_t3_unknown', originalSessionUpdate: 'new_thing', raw: {} },
    ] as const) {
      assert.deepEqual(mapSessionUpdate(update as never, tools), { kind: 'ignore' });
    }
  });

  it('hands mode and config changes to the session', () => {
    assert.deepEqual(mapSessionUpdate({ sessionUpdate: 'current_mode_update', currentModeId: 'plan' }, tools), {
      kind: 'mode', currentModeId: 'plan',
    });
    assert.equal(mapSessionUpdate({ sessionUpdate: 'config_option_update', configOptions: [] }, tools).kind, 'config');
  });
});

describe('modes, permissions and stop reasons', () => {
  it('reads modes from ACP modes first, else the mode config option', () => {
    const configOptions = [{
      id: 'mode', name: 'Mode', type: 'select' as const, currentValue: 'build',
      options: [{ groupId: 'g', name: 'Agents', options: [{ value: 'build', name: 'Build' }, { value: 'plan', name: 'Plan' }] }],
    }];
    assert.deepEqual(modesFromSession({ configOptions }), {
      source: { kind: 'config', configId: 'mode' },
      state: {
        currentModeId: 'build',
        availableModes: [{ id: 'build', name: 'Build', description: null }, { id: 'plan', name: 'Plan', description: null }],
      },
    });
    const modes = { currentModeId: 'auto', availableModes: [{ id: 'auto', name: 'Auto' }] };
    assert.equal(modesFromSession({ modes, configOptions }).source.kind, 'modes');
    assert.deepEqual(modesFromSession({}), { source: { kind: 'none' }, state: null });
  });

  it("passes the agent's permission options through", () => {
    assert.deepEqual(mapPermissionOptions([
      { optionId: 'allow-with-updates', name: 'Yes, allow all edits during this session', kind: 'allow_always' },
      { optionId: 'x', name: 'Deny forever', kind: 'reject_forever' as never },
    ]), [
      { optionId: 'allow-with-updates', name: 'Yes, allow all edits during this session', kind: 'allow_always' },
      { optionId: 'x', name: 'Deny forever', kind: 'reject_once' },
    ]);
  });

  it('maps stop reasons', () => {
    assert.equal(mapStopReason('max_tokens'), 'max_tokens');
    assert.equal(mapStopReason('something_new'), 'end_turn');
  });
});
