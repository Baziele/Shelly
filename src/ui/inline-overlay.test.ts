import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, it } from 'node:test';
import { EmulatedTerminal } from '../../test/support/emulated-terminal.js';
import { eventually } from '../../test/support/eventually.js';
import { BUILTIN_COMMANDS, CommandRegistry } from '../commands/slash-commands.js';
import type { HostTerminal } from '../terminal/host-terminal.js';
import { InlineOverlay } from './inline-overlay.js';

const open = async (cols: number, rows: number) => {
  const term = new EmulatedTerminal(cols, rows);
  term.write('older output line\r\n~/acme-web $ ');
  const overlay = new InlineOverlay(term as unknown as HostTerminal, new CommandRegistry(BUILTIN_COMMANDS), 'ansi256', { onSubmit: () => {}, onCancel: () => {} });
  overlay.open(await term.cursor(), '__', 'find every file over one hundred megabytes');
  await eventually(() => term.screen(), (lines) => lines.some((line) => line.includes('__ find every file')));
  return { term, overlay };
};

describe('InlineOverlay', { timeout: 20_000 }, () => {
  it('paints nothing between a resize and relayout(), then repaints at the new width', async () => {
    const { term, overlay } = await open(90, 10);
    overlay.setBusy(true);
    overlay.setPreview('find . -type f -size +100M -print0 | xargs -0 ls -lh | sort -k5 -h');
    await eventually(() => term.screen(), (lines) => lines.some((line) => line.includes('xargs')));
    await term.flush();
    term.resize(50, 10);
    const writtenAtResize = term.output().length;
    // The spinner keeps drawing frames meanwhile; none may reach the reflowed screen. (A slow machine
    // can only draw fewer frames in this window, so the check cannot fail spuriously.)
    await sleep(200);
    assert.equal(term.output().length, writtenAtResize, 'painted at the old anchor after a resize');
    overlay.relayout(await term.cursor());
    const written = await eventually(() => term.output().length, (length) => length > writtenAtResize);
    assert.ok(written > writtenAtResize, 'did not repaint after relayout');
    overlay.close();
    const screen = await term.screen();
    assert.ok(screen.includes('older output line'), screen.join('\n'));
    overlay.destroy();
  });

  it('erases itself and shows the cursor when destroyed while open', async () => {
    const { term, overlay } = await open(80, 10);
    overlay.setBusy(true);
    await sleep(150);
    overlay.destroy();
    const output = term.output();
    assert.ok(output.lastIndexOf('\u001b[?25h') > output.lastIndexOf('\u001b[?25l'), 'cursor left hidden');
    const screen = await term.screen();
    assert.ok(!screen.some((line) => line.includes('__')), `overlay left on screen:\n${screen.join('\n')}`);
  });
});
