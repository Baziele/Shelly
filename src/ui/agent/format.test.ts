import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { displayWidth } from '../../render/text-width.js';
import type { ToolCall } from '../../protocol/schema.js';
import { diffExcerpt, diffLines, diffStats } from './diff.js';
import {
  formatDuration,
  formatPermission,
  formatPermissionOutcome,
  fitHints,
  formatStatus,
  formatSummary,
  formatTool,
  relativeTime,
  shortenPath,
  tidyTitle,
  type FormatContext,
} from './format.js';
import { lineText, sanitizeText, type Line } from './lines.js';

const context: FormatContext = { cwd: '/home/dev/app', home: '/home/dev', width: 60, agentName: 'claude', spinner: '⠋' };
const texts = (lines: readonly Line[]) => lines.map(lineText);
const tool = (partial: Partial<ToolCall>): ToolCall => ({
  id: 't1', title: 'Tool', kind: 'other', status: 'completed', locations: [], content: [], ...partial,
});

describe('paths and titles', () => {
  it('shortens paths relative to the shell, else with ~', () => {
    assert.equal(shortenPath('/home/dev/app/src/a.ts', context), 'src/a.ts');
    assert.equal(shortenPath('/home/dev/app', context), '.');
    assert.equal(shortenPath('/home/dev/other/b.ts', context), '~/other/b.ts');
    assert.equal(shortenPath('/etc/hosts', context), '/etc/hosts');
    assert.equal(shortenPath('relative/x', context), 'relative/x');
    assert.equal(shortenPath('/home/dev/application/x', context), '~/application/x', 'a sibling with a common prefix is not inside');
  });

  it('tidies titles: one line, paths shortened, wrapping backticks dropped', () => {
    assert.equal(tidyTitle('  Read /home/dev/app/src/a.ts  ', context), 'Read src/a.ts');
    assert.equal(tidyTitle('`ls -la /home/dev/app/dist`', context), 'ls -la dist');
    assert.equal(tidyTitle('Edit\n  /home/dev/notes.md:', context), 'Edit ~/notes.md:');
    assert.equal(tidyTitle('', context), 'Tool call');
  });

  it('removes escape sequences and control characters from tool output', () => {
    assert.equal(sanitizeText('\u001b[31mred\u001b[0m\tx\u0007'), 'red  x');
    assert.equal(sanitizeText('10%\r50%\r100%\ndone'), '100%\ndone');
    assert.equal(sanitizeText('\u001b]8;;http://x\u0007link\u001b]8;;\u0007'), 'link');
  });
});

describe('formatTool', () => {
  it('shows status glyphs', () => {
    assert.equal(texts(formatTool(tool({ status: 'pending' }), context))[0], '○ Tool');
    assert.equal(texts(formatTool(tool({ status: 'in_progress' }), context))[0], '⠋ Tool');
    assert.equal(texts(formatTool(tool({ status: 'completed' }), context))[0], '● Tool');
    assert.equal(texts(formatTool(tool({ status: 'failed' }), context))[0], '✗ Tool');
    assert.equal(texts(formatTool(tool({ status: 'in_progress' }), context, { stopped: true }))[0], '◼ Tool');
  });

  it('shows the last four lines of a command, with how many came before', () => {
    const output = Array.from({ length: 10 }, (_, index) => `line ${index + 1}`).join('\n');
    const lines = texts(formatTool(tool({ kind: 'execute', title: '`npm test`', content: [{ type: 'text', text: output, truncated: false }] }), context));
    assert.deepEqual(lines, ['● $ npm test', '  … 6 more lines', '  │ line 7', '  │ line 8', '  │ line 9', '  │ line 10']);
  });

  it('shows an edit as counts and the first changed lines', () => {
    const lines = texts(formatTool(tool({
      kind: 'edit',
      title: 'Edit /home/dev/app/a.ts',
      content: [{ type: 'diff', path: '/home/dev/app/a.ts', oldText: 'a\nb\nc\n', newText: 'a\nB\nc\nd\n', truncated: false }],
    }), context));
    assert.deepEqual(lines, ['● Edit a.ts  +2 −1', '    a', '  - b', '  + B', '    c', '  + d']);
  });

  it('shows the first error line of a failed tool, in its own words', () => {
    const lines = texts(formatTool(tool({
      kind: 'read',
      status: 'failed',
      title: 'Read /home/dev/app/.env',
      content: [{ type: 'text', text: 'trace start\nError: ENOENT: no such file, open \'/home/dev/app/.env\'', truncated: false }],
    }), context));
    assert.deepEqual(lines, ['✗ Read .env', '  Error: ENOENT: no such file, open \'.env\'']);
  });

  it('counts what reads and searches returned', () => {
    const read = tool({ kind: 'read', title: 'Read a.ts', content: [{ type: 'text', text: 'a\nb\nc\n', truncated: false }] });
    const search = tool({ kind: 'search', title: 'grep x', content: [{ type: 'text', text: 'a:1\n\nb:2', truncated: false }] });
    assert.deepEqual(texts(formatTool(read, context)), ['● Read a.ts · 3 lines']);
    assert.deepEqual(texts(formatTool(search, context)), ['● grep x · 2 results']);
  });

  it('folds a permission answer into the row and drops the rejection error', () => {
    const rejected = tool({ status: 'failed', content: [{ type: 'text', text: 'The user rejected this action.', truncated: false }] });
    assert.deepEqual(texts(formatTool(rejected, context, { permission: 'reject_once' })), ['✗ Tool · rejected']);
    assert.deepEqual(texts(formatTool(tool({}), context, { permission: 'allow_always' })), ['● Tool · always allowed']);
  });

  it('keeps every row within the width', () => {
    const long = tool({ kind: 'execute', title: 'x'.repeat(200), content: [{ type: 'text', text: 'y'.repeat(200), truncated: false }] });
    for (const line of texts(formatTool(long, { ...context, width: 40 }))) {
      assert.ok(line.length <= 40, `too wide: ${line}`);
    }
  });
});

describe('permission prompts', () => {
  const options = [
    { optionId: 'a', name: 'Allow once', kind: 'allow_once' as const },
    { optionId: 'b', name: 'Allow always', kind: 'allow_always' as const },
    { optionId: 'c', name: 'Reject', kind: 'reject_once' as const },
  ];

  it('puts the options side by side, marking the selected one', () => {
    const lines = texts(formatPermission({ title: '`rm -rf /home/dev/app/dist`', options, selected: 1 }, context));
    assert.deepEqual(lines, ['? claude wants to: rm -rf dist', '  Allow once  ❯ Allow always    Reject']);
  });

  it('stacks the options when they do not fit across', () => {
    const lines = texts(formatPermission({ title: 'x', options, selected: 0 }, { ...context, width: 30 }));
    assert.deepEqual(lines.slice(1), ['  ❯ Allow once', '    Allow always', '    Reject']);
  });

  it('collapses to a muted outcome line', () => {
    assert.equal(lineText(formatPermissionOutcome('Run x', 'allow_once', context)), '✓ Allowed once: Run x');
    assert.equal(lineText(formatPermissionOutcome('Run x', 'reject_once', context)), '✗ Rejected: Run x');
    assert.equal(lineText(formatPermissionOutcome('Run x', null, context)), '◼ Cancelled: Run x');
  });
});

describe('status and summary', () => {
  it('right-aligns the hints that fit, shortening and dropping the least important first', () => {
    const running = {
      phase: 'Thinking',
      elapsedMs: 3200,
      hints: [{ text: 'esc background', short: 'esc', priority: 2 }, { text: '^c stop', short: '^c', priority: 1 }],
    };
    const wide = lineText(formatStatus(running, context));
    assert.ok(wide.startsWith('⠋ Thinking · 3s') && wide.endsWith('esc background · ^c stop ') && wide.length === 60, wide);
    assert.ok(lineText(formatStatus(running, { ...context, width: 32 })).endsWith(' esc · ^c stop '));
    assert.equal(lineText(formatStatus(running, { ...context, width: 18 })), '⠋ Thinking · 3s');

    const waiting = {
      phase: 'Waiting for you',
      elapsedMs: 0,
      hints: [
        { text: '←→ select', priority: 3 },
        { text: 'enter confirm', short: 'enter', priority: 1 },
        { text: 'esc reject', short: 'esc', priority: 2 },
      ],
    };
    const at = (width: number) => lineText(formatStatus(waiting, { ...context, width }));
    assert.ok(at(100).endsWith('←→ select · enter confirm · esc reject '), at(100));
    assert.ok(at(80).endsWith('←→ select · enter confirm · esc reject '), at(80));
    assert.ok(at(44).endsWith('enter confirm · esc '), at(44));
    for (const width of [100, 80, 60, 44, 36, 30, 24]) {
      const line = at(width);
      assert.ok(displayWidth(line) <= width, `fits ${width}: ${line}`);
      assert.ok(!/(·|select|confirm|reject) ?$/.test(line.trimEnd()) || /(select|confirm|reject|enter|esc)$/.test(line.trimEnd()), `no cut word at ${width}: ${line}`);
    }
  });

  it('ellipsizes the last hint rather than cutting it', () => {
    assert.equal(fitHints([{ text: 'press enter to confirm', priority: 1 }], 12), 'press enter…');
    assert.equal(fitHints([{ text: 'press enter to confirm', priority: 1 }], 4), '');
  });

  it('says how each turn ended', () => {
    const summary = (stopReason: Parameters<typeof formatSummary>[0]['stopReason'], error: string | null = null, tools = 0) =>
      lineText(formatSummary({ stopReason, error, durationMs: 12_400 }, tools, context));
    assert.equal(summary('end_turn', null, 3), '✓ 12s · 3 tools');
    assert.equal(summary('end_turn', null, 1), '✓ 12s · 1 tool');
    assert.equal(summary('end_turn'), '✓ 12s');
    assert.equal(summary('cancelled'), '◼ Stopped · 12s');
    assert.equal(summary('error', 'API connection lost'), '✗ API connection lost');
    assert.equal(summary('error'), '✗ claude failed');
    assert.equal(summary('refusal'), '✗ claude declined to continue');
    assert.equal(summary('max_tokens'), '◼ Stopped: claude reached its output limit · 12s');
    assert.equal(summary('interrupted'), '✗ Interrupted: claude stopped unexpectedly');
  });

  it('formats durations and relative times', () => {
    assert.equal(formatDuration(900), '0s');
    assert.equal(formatDuration(65_000), '1m 05s');
    assert.equal(formatDuration(3_725_000), '1h 02m');
    const now = Date.UTC(2026, 10, 27, 12);
    assert.equal(relativeTime(now - 10_000, now), 'just now');
    assert.equal(relativeTime(now - 5 * 60_000, now), '5m ago');
    assert.equal(relativeTime(now - 2 * 3_600_000, now), '2h ago');
    assert.equal(relativeTime(now - 26 * 3_600_000, now), 'yesterday');
    assert.equal(relativeTime(now - 5 * 86_400_000, now), '5d ago');
  });
});

describe('diff', () => {
  it('finds added and removed lines', () => {
    const lines = diffLines('a\nb\nc\nd\n', 'a\nc\nd\ne\n');
    assert.deepEqual(diffStats(lines), { added: 1, removed: 1 });
    assert.deepEqual(lines.map((line) => `${line.kind[0]}${line.text}`), ['ca', 'rb', 'cc', 'cd', 'ae']);
  });

  it('treats a new file as all additions', () => {
    assert.deepEqual(diffStats(diffLines(null, 'x\ny\n')), { added: 2, removed: 0 });
  });

  it('excerpts the first hunk with a line of context and counts the rest', () => {
    const before = Array.from({ length: 30 }, (_, index) => `l${index}`);
    const after = [...before];
    after[2] = 'changed';
    after[20] = 'also changed';
    const excerpt = diffExcerpt(diffLines(before.join('\n'), after.join('\n')), 8);
    assert.deepEqual(excerpt.lines.map((line) => line.text), ['l1', 'l2', 'changed', 'l3']);
    assert.equal(excerpt.moreChanges, 2);
  });
});
