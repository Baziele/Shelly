import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, it } from 'node:test';
import { EmulatedTerminal } from '../../test/support/emulated-terminal.js';
import { BUILTIN_COMMANDS, CommandRegistry } from '../commands/slash-commands.js';
import type { ThreadEvent } from '../protocol/schema.js';
import type { HostTerminal } from '../terminal/host-terminal.js';
import { AgentView } from './agent/agent-view.js';
import { renderHistory } from './agent/history.js';
import { renderAnswer } from './agent/static-render.js';
import { InlineOverlay } from './inline-overlay.js';

/*
 * Text from the agent or the daemon (answers, file contents the agent
 * quotes, web pages it read, titles) must never reach the terminal as
 * control sequences: no clipboard writes (OSC 52), title changes, hyperlinks
 * with a fake label (OSC 8), cursor moves, screen clears, or bidi overrides
 * that make a title read as something else.
 */
const HOSTILE = [
  'a\u001b]52;c;cm0gLXJmIH4=\u0007',          // OSC 52: write to the clipboard
  'b\u001b]0;pwned\u001b\\',                  // OSC 0: window title, ST-terminated
  'c\u001b[2J\u001b[H\u001b[31m',             // clear screen, home, colour
  'd\u009b6n\u009d0;x\u009c',                 // 8-bit CSI and OSC
  'e\u001bP+q544e\u001b\\',                   // DCS
  'f\u001b_apc\u001b\\\u001b^pm\u001b\\',     // APC, PM
  'g\u001b]8;;https://evil.example\u0007safe label\u001b]8;;\u0007',
  'h\u202egnp.exe\u202c\u2066x\u2069',        // bidi overrides and isolates
  'i\u0007\u0008\u000b\u000c\r\u007f\u0085',  // BEL, BS, VT, FF, CR, DEL, NEL
  'j\u001b',                                   // a lone escape at the end
].join(' ');

/** Shelly's own sequences: colours, cursor moves, erases, cursor visibility, synchronized output, cursor queries. */
const SHELLY_SEQUENCES = /\u001b\[[0-9;]*[mHKJ]|\u001b\[\?(?:25|2026)[hl]|\u001b\[6n/g;
const FORBIDDEN = /[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;

/** Payloads of the sequences above; removing only the ESC would leave them on screen as junk. */
const PAYLOADS = ['pwned', 'cm0gLXJmIH4=', '544e', 'evil.example', 'apc', ']52;', '[2J'];

const assertNoPayloads = (lines: readonly string[], where: string): void => {
  for (const payload of PAYLOADS) {
    const line = lines.find((candidate) => candidate.includes(payload));
    assert.equal(line, undefined, `${where}: ${JSON.stringify(payload)} shows on screen in ${JSON.stringify(line)}`);
  }
};

const assertSafe = (output: string, where: string): void => {
  const rest = output.replace(SHELLY_SEQUENCES, '');
  const match = FORBIDDEN.exec(rest);
  assert.equal(match, null, `${where}: ${JSON.stringify(match?.[0])} reached the terminal near ${JSON.stringify(rest.slice(Math.max(0, (match?.index ?? 0) - 20), (match?.index ?? 0) + 20))}`);
};

let seq = 0;
const event = (partial: Record<string, unknown>): ThreadEvent => ({ seq: ++seq, turnId: 't', ...partial }) as unknown as ThreadEvent;

describe('hostile text from the agent', { timeout: 30_000 }, () => {
  it('never reaches the terminal as control sequences in a live turn', async () => {
    const term = new EmulatedTerminal(100, 30);
    const view = new AgentView(term, 'truecolor', { agentName: `claude${HOSTILE}`, cwd: '/home/dev/app', home: '/home/dev' });
    view.start({ row: 1, col: 1 });
    const tool = (status: string, extra: Record<string, unknown> = {}) => event({
      type: 'tool.updated',
      tool: { id: 'x', title: `Run ${HOSTILE}`, kind: 'execute', status, locations: [{ path: `/tmp/${HOSTILE}`, line: null }], content: [{ type: 'text', text: HOSTILE, truncated: false }], ...extra },
    });
    const events: ThreadEvent[] = [
      event({ type: 'turn.started', text: HOSTILE, at: Date.now() }),
      event({ type: 'message.chunk', messageId: 'th', kind: 'thought', text: HOSTILE }),
      event({ type: 'plan.updated', entries: [{ content: HOSTILE, priority: 'high', status: 'in_progress' }] }),
      event({ type: 'message.chunk', messageId: 'm1', kind: 'text', text: `# ${HOSTILE}\n\n**${HOSTILE}** \`${HOSTILE}\` [${HOSTILE}](https://x.example)\n\n| ${HOSTILE} | b |\n|---|---|\n| ${HOSTILE} | 2 |\n\n\`\`\`sh\n${HOSTILE}\n\`\`\`\n` }),
      tool('in_progress'),
      event({ type: 'permission.requested', requestId: 'p', toolCallId: 'x', title: HOSTILE, options: [{ optionId: 'o', name: HOSTILE, kind: 'allow_once' }] }),
    ];
    for (const item of events) {
      view.apply(item);
    }
    await sleep(120);
    view.handleInput('\r');
    for (const item of [
      tool('failed'),
      event({ type: 'tool.updated', tool: { id: 'y', title: HOSTILE, kind: 'edit', status: 'completed', locations: [], content: [{ type: 'diff', path: HOSTILE, oldText: HOSTILE, newText: `${HOSTILE}\nmore`, truncated: false }] } }),
      event({ type: 'notice', level: 'warning', text: HOSTILE }),
      event({ type: 'notice', level: 'error', text: HOSTILE }),
      event({ type: 'mode.changed', currentModeId: 'm', availableModes: [{ id: 'm', name: HOSTILE, description: HOSTILE }] }),
      event({ type: 'permission.requested', requestId: 'q', toolCallId: null, title: HOSTILE, options: [{ optionId: 'r', name: HOSTILE, kind: 'reject_once' }] }),
      event({ type: 'turn.ended', stopReason: 'error', error: HOSTILE, durationMs: 10 }),
    ]) {
      view.apply(item);
    }
    await view.finish();
    view.destroy();
    assertSafe(term.output(), 'agent view');
    assertNoPayloads(await term.allLines(), 'agent view');
  });

  it('never reaches the terminal in history, fast-mode answers or the input', async () => {
    const history = await renderHistory([
      event({ type: 'turn.started', text: HOSTILE, at: 0 }),
      event({ type: 'tool.updated', tool: { id: 'x', title: HOSTILE, kind: 'read', status: 'completed', locations: [], content: [] } }),
      event({ type: 'message.chunk', messageId: 'm', kind: 'text', text: `${HOSTILE}\n\n- ${HOSTILE}` }),
      event({ type: 'turn.ended', stopReason: 'error', error: HOSTILE, durationMs: 1 }),
    ], { agentName: HOSTILE, title: HOSTILE, updatedAt: 0, cwd: '/', home: '/home/dev', width: 80, colorDepth: 'ansi256' });
    assertSafe(history, 'history');
    const shown = new EmulatedTerminal(80, 40);
    shown.write(history);
    assertNoPayloads(await shown.allLines(), 'history');

    assertSafe(await renderAnswer(`${HOSTILE}\n\n\`${HOSTILE}\``, 80, 'ansi256'), 'fast-mode answer');

    const term = new EmulatedTerminal(100, 10);
    const overlay = new InlineOverlay(term as unknown as HostTerminal, new CommandRegistry(BUILTIN_COMMANDS), 'truecolor', { onSubmit: () => {}, onCancel: () => {} });
    overlay.open({ row: 1, col: 1 }, '__', '', { rewriting: HOSTILE, hint: HOSTILE });
    await sleep(40);
    overlay.setBusy(true);
    overlay.setPreview(HOSTILE);
    await sleep(40);
    overlay.setError(HOSTILE);
    await sleep(40);
    overlay.openPicker({ items: [{ id: '1', label: HOSTILE, columns: [HOSTILE, HOSTILE] }], placeholder: HOSTILE, onPick: () => {}, onClose: () => {} });
    await sleep(60);
    const lines = await term.screen();
    overlay.destroy();
    assertSafe(term.output(), 'input');
    assertNoPayloads(lines, 'input');
  });
});
