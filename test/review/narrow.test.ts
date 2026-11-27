import assert from 'node:assert/strict';
import { describe, it, afterEach } from 'node:test';
import { ev, setup, shot, sleep } from './support.js';
import type { AgentView } from '../../src/ui/agent/agent-view.js';

let view: AgentView | undefined;
afterEach(() => { view?.destroy(); view = undefined; });

describe('review: narrow widths', () => {
  it('the "⋮ N more lines above" note fits a 40-column terminal', async () => {
    const s = await setup(40, 12);
    view = s.view;
    const code = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n');
    s.view.apply(ev({ type: 'message.chunk', messageId: 'm', kind: 'text', text: 'Here:\n\n```ts\n' + code }));
    await sleep(200);
    await shot(s.term, 'narrow-40-clip-note');
    const buffer = s.term.terminal.buffer.active;
    const wrapped = Array.from({ length: buffer.length }, (_, i) => buffer.getLine(i)!).filter((l) => l.isWrapped).length;
    const screen = await s.term.screen();
    assert.equal(wrapped, 0, `a live row wrapped:\n${screen.join('\n')}`);
  });

  it('emoji / wide text exactly filling a row does not wrap or shift the live region', async () => {
    const s = await setup(40, 12);
    view = s.view;
    // VS16 emoji and a flag: one of the classic width disagreements between layout engines and terminals.
    const line = 'ok ❤️ 🇯🇵 👩‍💻 漢字 ' + 'x'.repeat(40);
    s.view.apply(ev({ type: 'message.chunk', messageId: 'm', kind: 'text', text: `${line}\n\n${line}` }));
    await sleep(200);
    await shot(s.term, 'narrow-40-emoji-live');
    s.view.apply(ev({ type: 'turn.ended', stopReason: 'end_turn', error: null, durationMs: 1000 }));
    await s.view.finish();
    await shot(s.term, 'narrow-40-emoji-final');
    const lines = await s.term.allLines();
    assert.ok(!lines.some((l) => /esc|⠋|⠙|⠹|⠸|⠼|⠴|⠦|⠧|⠇|⠏/.test(l)), lines.join('\n'));
  });
});
