import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, describe, it } from 'node:test';
import { EmulatedTerminal } from '../../test/support/emulated-terminal.js';
import { BUILTIN_COMMANDS, CommandRegistry } from '../commands/slash-commands.js';
import type { HostTerminal } from '../terminal/host-terminal.js';
import { InlineOverlay, type OverlayOpenOptions } from './inline-overlay.js';
import type { PickerItem } from './list-picker.js';

const PROMPT = '~/acme-web $ ';
let overlay: InlineOverlay | undefined;

const open = async (cols: number, trigger: string, input = '', options: OverlayOpenOptions = {}) => {
  const term = new EmulatedTerminal(cols, 10);
  term.write(PROMPT);
  const events: string[] = [];
  overlay = new InlineOverlay(term as unknown as HostTerminal, new CommandRegistry(BUILTIN_COMMANDS), 'ansi256', {
    onSubmit: (text) => events.push(`submit:${text}`),
    onCancel: () => events.push('cancel'),
  });
  overlay.open({ row: 1, col: PROMPT.length + 1 }, trigger, input, options);
  const screen = async (): Promise<string[]> => {
    await sleep(60);
    return (await term.screen()).filter((line) => line !== '');
  };
  return { term, overlay, events, screen };
};

describe('PromptView', { timeout: 20_000 }, () => {
  afterEach(() => {
    overlay?.destroy();
    overlay = undefined;
  });

  it('opens fast mode with its own placeholder, and a rewriting row for a captured command', async () => {
    const fast = await open(80, '__');
    assert.deepEqual(await fast.screen(), [`${PROMPT}__ Describe a command · enter to insert`]);
    overlay?.destroy();
    const rewrite = await open(80, '__', '', { rewriting: 'git log --oneline' });
    assert.deepEqual(await rewrite.screen(), [`${PROMPT}__ How should it change?`, '                rewriting: git log --oneline']);
  });

  it('shows the hint right-aligned, shortens the placeholder for it, and hides it when there is no room', async () => {
    const wide = await open(80, '::', '', { hint: '● claude is working · enter to watch' });
    const [row] = await wide.screen();
    assert.ok(row!.startsWith(`${PROMPT}:: Ask anything`) && row!.endsWith('● claude is working · enter to watch') && row!.length === 80, row ?? '');
    overlay?.destroy();
    const narrow = await open(44, '::', 'why did the build fail', { hint: 'claude · new thread' });
    assert.deepEqual(await narrow.screen(), [`${PROMPT}:: why did the build fail`]);
  });

  it('keeps the request, spins and streams the reply while busy, then shows an error and lets you retry', async () => {
    const view = await open(80, '__', 'find files over 100MB');
    view.overlay.setBusy(true);
    view.overlay.setPreview('find . -type f -size +100M');
    const [busy] = await view.screen();
    assert.match(busy!, /^~\/acme-web \$ __ find files over 100MB [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] find \. -type f -size \+100M$/);

    view.overlay.feed('x');
    view.overlay.setError('Fast mode is unavailable');
    const lines = await view.screen();
    assert.deepEqual(lines, [`${PROMPT}__ find files over 100MB`, '                ✗ Fast mode is unavailable'], 'typing while busy is ignored');

    view.overlay.feed('!');
    assert.deepEqual(await view.screen(), [`${PROMPT}__ find files over 100MB!`], 'the error clears once you edit');
  });

  it('moves a long preview to its own row on a narrow terminal', async () => {
    const view = await open(44, '__', 'find files over 100MB');
    view.overlay.setBusy(true);
    view.overlay.setPreview('find . -type f -size +100M -exec ls -lh {} +');
    const lines = await view.screen();
    assert.equal(lines.length, 2);
    assert.equal(lines[1], '                …ize +100M -exec ls -lh {} +');
  });

  it('cancels a busy request on escape', async () => {
    const view = await open(80, '__', 'x');
    view.overlay.setBusy(true);
    view.overlay.feed('\u001b');
    await sleep(30);
    assert.deepEqual(view.events, ['cancel']);
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
    assert.deepEqual(await view.screen(), [
      `${PROMPT}:: Pick a thread · type to filter`,
      '              › fix the build    claude    2m ago',
      '                rename payments  opencode  1h ago',
      '                refresh tokens   claude    yesterday',
    ]);
    view.overlay.feed('re');
    await sleep(30);
    view.overlay.feed('\u001b[B');
    await sleep(30);
    view.overlay.feed('\r');
    await sleep(30);
    assert.deepEqual(picked, ['c']);
    view.overlay.feed('\u001b');
    await sleep(30);
    assert.deepEqual(picked, ['c', 'closed']);
    assert.deepEqual(await view.screen(), [`${PROMPT}:: Ask Shelly anything · / for commands`]);
  });
});
