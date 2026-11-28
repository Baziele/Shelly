import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { displayWidth } from '../../render/text-width.js';
import type { ToolCall } from '../../protocol/schema.js';
import { diffExcerpt, diffLines, diffStats } from './diff.js';
import {
  commandTitle,
  formatDuration,
  formatNotice,
  formatPermission,
  formatPermissionOutcome,
  fitHints,
  formatStatus,
  formatSummary,
  formatTool,
  relativeTime,
  shortenPath,
  shortToolTitle,
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
    assert.deepEqual(lines, ['● $ npm test', '  │ … 6 more lines', '  │ line 7', '  │ line 8', '  │ line 9', '  │ line 10']);
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

describe('tool output that matters', () => {
  it('shows a failed command\'s error lines and its last line, the gap marked inside the gutter', () => {
    const output = [
      'cc -o app src/main.c',
      'main.c:12: error: unknown conifg',
      '    conifg.port = 8080;',
      '    ^',
      '1 error generated.',
      'make: *** [build] Error 1',
    ].join('\n');
    const lines = texts(formatTool(tool({ kind: 'execute', status: 'failed', title: '`make build`', content: [{ type: 'text', text: output, truncated: false }] }), context));
    assert.deepEqual(lines, [
      '✗ $ make build',
      '  │ … 1 more line',
      '  │ main.c:12: error: unknown conifg',
      '  │ … 2 more lines',
      '  │ 1 error generated.',
      '  │ make: *** [build] Error 1',
    ]);
  });

  it('keeps the tail of a failed command with no error lines', () => {
    const output = Array.from({ length: 6 }, (_, index) => `step ${index + 1}`).join('\n');
    const lines = texts(formatTool(tool({ kind: 'execute', status: 'failed', title: 'x', content: [{ type: 'text', text: output, truncated: false }] }), context));
    assert.deepEqual(lines.slice(1), ['  │ … 2 more lines', '  │ step 3', '  │ step 4', '  │ step 5', '  │ step 6']);
  });

  it('shows only the counts an edit has: no −0 on a pure addition', () => {
    const added = tool({ kind: 'edit', title: 'Write a.ts', content: [{ type: 'diff', path: '/home/dev/app/a.ts', oldText: null, newText: 'a\nb\n', truncated: false }] });
    assert.equal(texts(formatTool(added, context))[0], '● Write a.ts  +2');
    const removed = tool({ kind: 'edit', title: 'Edit a.ts', content: [{ type: 'diff', path: '/home/dev/app/a.ts', oldText: 'a\nb\n', newText: 'a\n', truncated: false }] });
    assert.equal(texts(formatTool(removed, context))[0], '● Edit a.ts  −1');
  });

  it('drops a cd into the shell\'s own directory from a command', () => {
    const exec = (title: string) => texts(formatTool(tool({ kind: 'execute', title }), context))[0];
    assert.equal(exec('`cd "." && make build`'), '● $ make build');
    assert.equal(exec('`cd . && ls`'), '● $ ls');
    assert.equal(exec('`cd /home/dev/app && pnpm test`'), '● $ pnpm test');
    assert.equal(exec('`cd /tmp && ls`'), '● $ cd /tmp && ls', 'a cd elsewhere matters');
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

describe('command titles', () => {
  it('reads an execute title as the command it runs', () => {
    assert.equal(commandTitle('Run `pnpm test`'), 'pnpm test');
    assert.equal(commandTitle('Running `make build`'), 'make build');
    assert.equal(commandTitle('Terminal: `ls -la`'), 'ls -la');
    assert.equal(commandTitle('`git status`'), 'git status');
    // Claude Code titles the call with the command itself once it knows it.
    assert.equal(commandTitle("printf 'hi\\n' > allowed.txt"), "printf 'hi\\n' > allowed.txt");
    // A description, not a command in backticks, stays as it is.
    assert.equal(commandTitle('Run the test suite'), 'Run the test suite');
    // Generic names, before the command is known, are not commands.
    assert.equal(commandTitle('Terminal'), undefined);
    assert.equal(commandTitle('bash'), undefined);
  });

  it('shows `$ command` rows, and generic names without the prompt sign', () => {
    const exec = (title: string): ToolCall => ({ id: 't', title, kind: 'execute', status: 'completed', locations: [], content: [] });
    assert.match(lineText(formatTool(exec('Run `pnpm test`'), context)[0]!), /^. \$ pnpm test$/);
    assert.match(lineText(formatTool(exec('Terminal'), context)[0]!), /^. Terminal$/);
    // The status line names a running command by its first word: the whole command is on its own row.
    assert.equal(shortToolTitle(exec('Run `pnpm test`'), context), 'pnpm');
    assert.equal(shortToolTitle(exec('Terminal'), context), 'a command');
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
      elapsedMs: 1000,
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

  it('keeps what esc does on a 40-column status line', () => {
    const status = { phase: 'Writing', elapsedMs: 3200, hints: [{ text: 'esc background', short: 'esc bg', priority: 2 }, { text: '^c stop', short: '^c', priority: 1 }] };
    assert.ok(lineText(formatStatus(status, { ...context, width: 40 })).trimEnd().endsWith('esc bg · ^c stop'));
  });

  it('ellipsizes the last hint rather than cutting it', () => {
    assert.equal(fitHints([{ text: 'press enter to confirm', priority: 1 }], 12), 'press enter…');
    assert.equal(fitHints([{ text: 'press enter to confirm', priority: 1 }], 4), '');
  });

  it('says how each turn ended', () => {
    const summary = (stopReason: Parameters<typeof formatSummary>[0]['stopReason'], error: string | null = null, tools = 0) =>
      formatSummary({ stopReason, error, durationMs: 12_400 }, { toolCount: tools, produced: true, noticed: false }, context).map(lineText);
    assert.deepEqual(summary('end_turn', null, 3), ['✓ 12s · 3 tools']);
    assert.deepEqual(summary('end_turn', null, 1), ['✓ 12s · 1 tool']);
    assert.deepEqual(summary('end_turn'), ['✓ 12s']);
    assert.deepEqual(summary('cancelled'), ['◼ Stopped · 12s']);
    assert.deepEqual(summary('max_tokens'), ['◼ Stopped: claude reached its output limit · 12s']);
    assert.deepEqual(summary('refusal'), ['✗ claude declined to continue · 12s', '']);
  });

  it('ends a failed turn with its time, a next step and a blank row before the prompt', () => {
    const lines = formatSummary({ stopReason: 'error', error: 'API connection lost', durationMs: 3_100 }, { toolCount: 0, produced: false, noticed: false }, context).map(lineText);
    assert.deepEqual(lines, ['✗ API connection lost · 3s', '  Try again, or check `claude` on its own.', '']);
    const interrupted = formatSummary({ stopReason: 'interrupted', error: null, durationMs: 500 }, { toolCount: 0, produced: true, noticed: false }, context).map(lineText);
    assert.equal(interrupted[0], '✗ Interrupted: claude stopped unexpectedly · <1s');
  });

  it('wraps a long error instead of cutting off its end', () => {
    const error = 'claude-agent-acp exited (code 1): not signed in; run `claude login` in a terminal, then try again';
    const lines = formatSummary({ stopReason: 'error', error, durationMs: 1_000 }, { toolCount: 0, produced: false, noticed: false }, { ...context, width: 50 }).map(lineText);
    assert.ok(lines.every((line) => line.length <= 50), lines.join('\n'));
    assert.ok(!lines.some((line) => line.includes('…')), lines.join('\n'));
    assert.match(lines.join(' ').replace(/\s+/g, ' '), /then try again · 1s/);
  });

  it('leaves no footer for a turn that showed nothing but a notice, and says so when it showed nothing at all', () => {
    const outcome = { stopReason: 'end_turn' as const, error: null, durationMs: 200 };
    assert.deepEqual(formatSummary(outcome, { toolCount: 0, produced: false, noticed: true }, context), []);
    assert.deepEqual(formatSummary(outcome, { toolCount: 0, produced: false, noticed: false }, context).map(lineText), ['◼ No reply · <1s']);
  });

  it('wraps notices, with a bold label and a warning in the default colour', () => {
    const text = 'fake ended the turn without a reply. If it keeps doing that, check that it is signed in.';
    const lines = formatNotice('warning', text, 50);
    assert.ok(lines.length > 1 && lines.every((line) => lineText(line).length <= 50));
    assert.ok(!lines.some((line) => lineText(line).includes('…')));
    assert.equal(lineText(lines[1]!).slice(0, 2), '  ', 'continuation rows line up under the text');
    assert.deepEqual([lines[0]![0]!.tone, lines[0]![0]!.bold, lines[0]![1]!.tone], ['warning', true, undefined]);
  });

  it('formats durations and relative times', () => {
    assert.equal(formatDuration(900), '<1s');
    assert.equal(formatDuration(1_000), '1s');
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
