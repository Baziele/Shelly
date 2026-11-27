import assert from 'node:assert/strict';
import { describe, it, afterEach } from 'node:test';
import { EmulatedTerminal } from '../support/emulated-terminal.js';
import { useModernWidths } from '../tools/unicode.js';
import { BUILTIN_COMMANDS, CommandRegistry } from '../../src/commands/slash-commands.js';
import type { HostTerminal } from '../../src/terminal/host-terminal.js';
import { InlineOverlay } from '../../src/ui/inline-overlay.js';
import { shot, sleep } from './support.js';

let overlay: InlineOverlay | undefined;
afterEach(() => { overlay?.destroy(); overlay = undefined; });

const make = async (cols: number, rows: number, prompt: string) => {
  const term = new EmulatedTerminal(cols, rows);
  useModernWidths(term.terminal);
  term.write('\r\n'.repeat(rows)); // cursor at the bottom row
  term.write(prompt);
  const cursor = await term.cursor();
  const events: string[] = [];
  overlay = new InlineOverlay(term as unknown as HostTerminal, new CommandRegistry(BUILTIN_COMMANDS), 'ansi256', {
    onSubmit: (t) => events.push(`submit:${t}`), onCancel: () => events.push('cancel'),
  });
  return { term, cursor, events, overlay };
};

describe('review: inline overlay', { timeout: 30_000 }, () => {
  it('at the bottom row, 40 cols, long prompt: slash popup, then close restores the prompt and cursor', async () => {
    const prompt = '~/projects/very-long-dir (main*) % ';
    const { term, cursor, overlay } = await make(40, 10, prompt);
    overlay.open(cursor, '::', '');
    await sleep(80);
    overlay.feed('/');
    await sleep(80);
    await shot(term, 'overlay-40-bottom-popup');
    overlay.feed('\u001b'); // dismiss popup
    overlay.feed('x'.repeat(60));
    await sleep(80);
    await shot(term, 'overlay-40-bottom-longinput');
    overlay.close();
    await sleep(20);
    await shot(term, 'overlay-40-bottom-closed');
    const screen = await term.screen();
    const c = await term.cursor();
    const promptRow = screen.findIndex((l) => l.startsWith('~/projects'));
    assert.equal(screen[promptRow]!.trimEnd(), prompt.trimEnd(), screen.join('\n'));
    assert.deepEqual(c, { row: promptRow + 1, col: prompt.length + 1 });
    assert.ok(screen.slice(promptRow + 1).every((l) => l === ''), `leftovers:\n${screen.join('\n')}`);
  });

  it('a prompt with wide characters: input lines up and close leaves the prompt intact', async () => {
    const prompt = '漢字🙂 ~/src ❯ ';
    const { term, cursor, overlay } = await make(60, 8, prompt);
    overlay.open(cursor, '__', 'list big files');
    await sleep(80);
    await shot(term, 'overlay-wide-prompt');
    const screen = await term.screen();
    const row = screen.find((l) => l.startsWith('漢字'))!;
    assert.equal(row, `${prompt}__ list big files`, row);
    overlay.close();
  });
});

describe('review: inline overlay resize', { timeout: 30_000 }, () => {
  it('narrowing while fast mode is busy (spinner running), relayout after the 50 ms settle', async () => {
    const term = new EmulatedTerminal(90, 10);
    useModernWidths(term.terminal);
    term.write('older output line\r\n~/acme-web $ ');
    const cursor = await term.cursor();
    overlay = new InlineOverlay(term as unknown as HostTerminal, new CommandRegistry(BUILTIN_COMMANDS), 'ansi256', { onSubmit: () => {}, onCancel: () => {} });
    overlay.open(cursor, '__', 'find every file over one hundred megabytes');
    await sleep(50);
    overlay.setBusy(true);
    overlay.setPreview('find . -type f -size +100M -print0 | xargs -0 ls -lh | sort -k5 -h');
    await sleep(120);
    await shot(term, 'overlay-resize-before');
    term.resize(50, 10);
    await sleep(60); // Shelly's RESIZE_SETTLE_MS is 50; the spinner paints meanwhile
    overlay.relayout(await term.cursor());
    await sleep(120);
    await shot(term, 'overlay-resize-after');
    overlay.close();
    await sleep(20);
    await shot(term, 'overlay-resize-closed');
    const screen = (await term.screen()).map((l) => l.trimEnd());
    assert.ok(screen.includes('older output line'), `older output clobbered:\n${screen.join('\n')}`);
    const leftovers = screen.filter((l) => /find|xargs|[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(l));
    assert.deepEqual(leftovers, [], `overlay leftovers after close:\n${screen.join('\n')}`);
  });
});
