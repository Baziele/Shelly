import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { EmulatedTerminal } from '../../test/support/emulated-terminal.js';
import { eventually, sameAs } from '../../test/support/eventually.js';
import { BUILTIN_COMMANDS, CommandRegistry } from '../commands/slash-commands.js';
import type { HostTerminal } from '../terminal/host-terminal.js';
import { InlineOverlay, type OverlayOpenOptions } from './inline-overlay.js';
import type { PickerItem } from './list-picker.js';

const PROMPT = '~/acme-web $ ';
let overlay: InlineOverlay | undefined;

const open = async (cols: number, trigger: string, input = '', options: OverlayOpenOptions = {}, rows = 10) => {
  const term = new EmulatedTerminal(cols, rows);
  term.write(PROMPT);
  const events: string[] = [];
  overlay = new InlineOverlay(term as unknown as HostTerminal, new CommandRegistry(BUILTIN_COMMANDS), 'ansi256', {
    onSubmit: (text) => events.push(`submit:${text}`),
    onCancel: () => events.push('cancel'),
  });
  overlay.open({ row: 1, col: PROMPT.length + 1 }, trigger, input, options);
  const read = async (): Promise<string[]> => (await term.screen()).filter((line) => line !== '');
  /** The screen once it matches `check` (or the last one read, to assert on). Frames land when they land. */
  const screen = (check: (lines: string[]) => boolean): Promise<string[]> => eventually(read, check);
  /** The screen once it equals `expected`. */
  const screenIs = (expected: string[]): Promise<string[]> => eventually(read, sameAs(expected));
  return { term, overlay, events, screen, screenIs };
};

describe('PromptView', { timeout: 20_000 }, () => {
  afterEach(() => {
    overlay?.destroy();
    overlay = undefined;
  });

  it('opens fast mode with its own placeholder, and a rewriting row for a captured command', async () => {
    const fast = await open(80, '__');
    const fastExpected = [`${PROMPT}__ Describe a command · enter to insert`];
    assert.deepEqual(await fast.screenIs(fastExpected), fastExpected);
    overlay?.destroy();
    const rewrite = await open(80, '__', '', { rewriting: 'git log --oneline' });
    const rewriteExpected = [`${PROMPT}__ How should it change?`, '                rewriting: git log --oneline'];
    assert.deepEqual(await rewrite.screenIs(rewriteExpected), rewriteExpected);
  });

  it('shows the hint right-aligned, shortens the placeholder for it, and hides it when there is no room', async () => {
    const wide = await open(80, '::', '', { hint: '● claude is working · enter to watch' });
    const [row] = await wide.screen((lines) => lines[0]?.endsWith('enter to watch') ?? false);
    // One cell stays free at the right edge (● and · are two cells wide in some terminals).
    assert.ok(row!.startsWith(`${PROMPT}:: Ask anything`) && row!.endsWith('● claude is working · enter to watch') && row!.length === 79, row ?? '');
    overlay?.destroy();
    const narrow = await open(44, '::', 'why did the build fail', { hint: 'claude · new thread' });
    const narrowExpected = [`${PROMPT}:: why did the build fail`];
    assert.deepEqual(await narrow.screenIs(narrowExpected), narrowExpected);
  });

  it('shows an error about a command without the command list over it, and the list again once typing goes on', async () => {
    const view = await open(80, '::', '/rename');
    await view.screen((lines) => lines.some((line) => line.includes('Rename this thread')));
    view.overlay.setError('Give it a name: /rename <title>');
    const shown = await view.screen((lines) => lines.some((line) => line.includes('✗ Give it a name')) && !lines.some((line) => line.includes('Rename this thread')));
    assert.ok(!shown.some((line) => line.includes('Rename this thread')), shown.join('\n'));
    view.overlay.feed('\u007f');
    const again = await view.screen((lines) => lines.some((line) => line.includes('Rename this thread')));
    assert.ok(!again.some((line) => line.includes('✗')), again.join('\n'));
  });

  it('keeps the request, spins and streams the reply while busy, then shows an error and lets you retry', async () => {
    const view = await open(80, '__', 'find files over 100MB');
    view.overlay.setBusy(true);
    view.overlay.setPreview('find . -type f -size +100M');
    const [busy] = await view.screen((lines) => lines[0]?.endsWith('+100M') ?? false);
    assert.match(busy!, /^~\/acme-web \$ __ find files over 100MB [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] find \. -type f -size \+100M$/);

    view.overlay.feed('x');
    view.overlay.setError('Fast mode is unavailable');
    const errorExpected = [`${PROMPT}__ find files over 100MB`, '                ✗ Fast mode is unavailable'];
    assert.deepEqual(await view.screenIs(errorExpected), errorExpected, 'typing while busy is ignored');

    view.overlay.feed('!');
    const editedExpected = [`${PROMPT}__ find files over 100MB!`];
    assert.deepEqual(await view.screenIs(editedExpected), editedExpected, 'the error clears once you edit');
  });

  it('moves a long preview to its own row on a narrow terminal', async () => {
    const view = await open(44, '__', 'find files over 100MB');
    view.overlay.setBusy(true);
    view.overlay.setPreview('find . -type f -size +100M -exec ls -lh {} +');
    const lines = await view.screen((rows) => rows.length === 2);
    assert.equal(lines.length, 2);
    assert.equal(lines[1], '                …ize +100M -exec ls -lh {} +');
  });

  it('cancels a busy request on escape', async () => {
    const view = await open(80, '__', 'x');
    view.overlay.setBusy(true);
    view.overlay.feed('\u001b');
    assert.deepEqual(await eventually(() => view.events, sameAs(['cancel'])), ['cancel']);
  });

  it('picks from a list: type to filter, arrows to move, enter to pick, escape to close', async () => {
    const view = await open(80, '::');
    const picked: string[] = [];
    const items: PickerItem[] = [
      { id: 'a', label: 'fix the build', columns: ['claude', '2m ago'] },
      { id: 'b', label: 'rename payments', columns: ['opencode', '1h ago'] },
      { id: 'c', label: 'refresh tokens', columns: ['claude', 'yesterday'] },
    ];
    view.overlay.openPicker({ items, placeholder: 'Pick a thread · type to filter', onPick: (item) => picked.push(item.id), onClose: () => picked.push('closed') });
    const listExpected = [
      `${PROMPT}:: Pick a thread · type to filter`,
      '              › fix the build    claude    2m ago',
      '                rename payments  opencode  1h ago',
      '                refresh tokens   claude    yesterday',
    ];
    assert.deepEqual(await view.screenIs(listExpected), listExpected);
    view.overlay.feed('re');
    await view.screen((lines) => lines[0]?.endsWith(':: re') ?? false);
    view.overlay.feed('\u001b[B');
    await view.screen((lines) => lines.some((line) => line.includes('› refresh tokens')));
    view.overlay.feed('\r');
    assert.deepEqual(await eventually(() => picked, sameAs(['c'])), ['c']);
    view.overlay.feed('\u001b');
    assert.deepEqual(await eventually(() => picked, sameAs(['c', 'closed'])), ['c', 'closed']);
    const closedExpected = [`${PROMPT}:: Ask Shelly anything · / for commands`];
    assert.deepEqual(await view.screenIs(closedExpected), closedExpected);
  });
});
describe('PromptView messages and lists', { timeout: 20_000 }, () => {
  afterEach(() => {
    overlay?.destroy();
    overlay = undefined;
  });

  it('wraps a fast-mode error at a narrow width instead of cutting off its end', async () => {
    const view = await open(50, '__', 'compress this folder');
    view.overlay.setBusy(true);
    const message = 'Fast mode is unavailable: claude is not signed in. Run `claude login` in a terminal, then try again.';
    view.overlay.setError(message);
    const lines = await view.screen((rows) => rows.some((row) => row.includes('again.')));
    const shown = lines.slice(1).join(' ').replace(/\s+/g, ' ');
    assert.ok(shown.includes('Run `claude login` in a terminal, then try again.'), lines.join('\n'));
    assert.ok(!lines.some((row) => row.includes('…')), lines.join('\n'));
    assert.ok(lines.every((row) => row.length <= 50));
  });

  it('shows every slash command that fits, and says how many more there are when they do not', async () => {
    const commands = new CommandRegistry(BUILTIN_COMMANDS).match('').length;
    const tall = await open(80, '::', '/', {}, 24);
    const all = await tall.screen((rows) => rows.length >= 1 + commands);
    assert.equal(all.length, 1 + commands, all.join('\n'));
    assert.ok(!all.some((row) => row.includes('more')));
    overlay?.destroy();

    const short = await open(80, '::', '/', {}, 7);
    const some = await short.screen((rows) => rows.some((row) => row.includes('more')));
    // 7 rows: the list gets 4, three commands and the note.
    assert.match(some.at(-1)!, new RegExp(`… ${commands - 3} more$`), some.join('\n'));
  });
});

