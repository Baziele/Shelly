import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { EmulatedTerminal } from '../support/emulated-terminal.js';
import { BUILTIN_COMMANDS, CommandRegistry } from '../../src/commands/slash-commands.js';
import type { HostTerminal } from '../../src/terminal/host-terminal.js';
import { InlineOverlay } from '../../src/ui/inline-overlay.js';
import { ev, setup, sleep } from './support.js';

const cursorHidden = (out: string) => out.lastIndexOf('\u001b[?25l') > out.lastIndexOf('\u001b[?25h');

describe('review: teardown', { timeout: 30_000 }, () => {
  it('AgentView.destroy() mid-turn (error path) leaves the cursor visible and no live rows', async () => {
    const s = await setup(80, 12);
    s.view.apply(ev({ type: 'message.chunk', messageId: 'm', kind: 'text', text: 'streaming' }));
    await sleep(150);
    s.view.destroy();
    const screen = (await s.term.screen()).join('\n');
    assert.ok(!cursorHidden(s.term.output()), 'cursor left hidden');
    assert.ok(!/esc background/.test(screen), `status line left on screen:\n${screen}`);
  });

  it('InlineOverlay.destroy() while open and busy (shell exited, e.g. TMOUT) restores the cursor', async () => {
    const term = new EmulatedTerminal(80, 10);
    term.write('$ ');
    const overlay = new InlineOverlay(term as unknown as HostTerminal, new CommandRegistry(BUILTIN_COMMANDS), 'ansi256', { onSubmit: () => {}, onCancel: () => {} });
    overlay.open(await term.cursor(), '__', 'list files');
    overlay.setBusy(true);
    await sleep(150);
    overlay.destroy();
    assert.ok(!cursorHidden(term.output()), 'cursor left hidden');
  });
});
