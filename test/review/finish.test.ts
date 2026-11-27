import assert from 'node:assert/strict';
import { describe, it, afterEach } from 'node:test';
import { ev, setup, sleep } from './support.js';
import type { AgentView } from '../../src/ui/agent/agent-view.js';

let view: AgentView | undefined;
afterEach(() => { view?.destroy(); view = undefined; });

describe('review: finish', { timeout: 120_000 }, () => {
  it('a 4,000-line code block that ends with the turn is committed whole', async () => {
    const s = await setup(100, 30);
    view = s.view;
    const n = 4000;
    const code = Array.from({ length: n }, (_, i) => `row ${i}`).join('\n');
    s.view.apply(ev({ type: 'message.chunk', messageId: 'm', kind: 'text', text: 'Intro.\n\n```\n' + code }));
    await sleep(500);
    s.view.apply(ev({ type: 'message.chunk', messageId: 'm', kind: 'text', text: '\n```\n' }));
    s.view.apply(ev({ type: 'turn.ended', stopReason: 'end_turn', error: null, durationMs: 1000 }));
    const t = performance.now();
    await s.view.finish();
    const ms = performance.now() - t;
    const lines = await s.term.allLines();
    const rows = lines.filter((l) => /^│ row \d+$/.test(l)).length;
    console.log(`finish took ${ms.toFixed(0)} ms; ${rows}/${n} code rows in scrollback; last line ${JSON.stringify(lines.at(-1))}`);
    assert.equal(rows, n);
  });

  it('finish() without turn.ended (e.g. the daemon connection dropped) keeps what was shown', async () => {
    const s = await setup(80, 20);
    view = s.view;
    s.view.apply(ev({ type: 'message.chunk', messageId: 'm', kind: 'text', text: 'First paragraph, complete.\n\nSecond paragraph, still stream' }));
    s.view.apply(ev({ type: 'tool.updated', tool: { id: 'b', title: 'make', kind: 'execute', status: 'in_progress', locations: [], content: [] } }));
    await sleep(200);
    await s.view.finish();
    const lines = await s.term.allLines();
    console.log(lines.join('\n'));
    assert.ok(lines.some((l) => l.includes('First paragraph')), 'first paragraph lost');
    assert.ok(lines.some((l) => l.includes('make')), 'running tool lost');
  });
});
