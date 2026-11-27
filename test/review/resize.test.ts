import assert from 'node:assert/strict';
import { describe, it, afterEach } from 'node:test';
import { ev, setup, shot, sleep } from './support.js';
import type { AgentView } from '../../src/ui/agent/agent-view.js';

let view: AgentView | undefined;
afterEach(() => { view?.destroy(); view = undefined; });

const para = (n: number) => Array.from({ length: n }, (_, i) => `Paragraph ${i + 1} explains a part of the change in a sentence long enough to wrap.`).join('\n\n');

describe('review: resize', () => {
  for (const settleMs of [0, 60, 200]) {
    it(`narrowing 90→50 cols mid-stream, relayout after ${settleMs} ms, leaves no stranded rows`, async () => {
      const s = await setup(90, 16);
      view = s.view;
      s.view.apply(ev({ type: 'tool.updated', tool: { id: 'a', title: 'pnpm test', kind: 'execute', status: 'completed', locations: [], content: [] } }));
      s.view.apply(ev({ type: 'message.chunk', messageId: 'm', kind: 'text', text: para(3) }));
      s.view.apply(ev({ type: 'tool.updated', tool: { id: 'b', title: 'sleep 10', kind: 'execute', status: 'in_progress', locations: [], content: [] } }));
      await sleep(200);
      await shot(s.term, `resize-${settleMs}-before`);
      s.term.resize(50, 16);
      await sleep(settleMs);
      await s.view.relayout();
      await sleep(200);
      await shot(s.term, `resize-${settleMs}-after-relayout`);
      s.view.apply(ev({ type: 'tool.updated', tool: { id: 'b', title: 'sleep 10', kind: 'execute', status: 'completed', locations: [], content: [] } }));
      s.view.apply(ev({ type: 'message.chunk', messageId: 'm2', kind: 'text', text: 'Done.' }));
      s.view.apply(ev({ type: 'turn.ended', stopReason: 'end_turn', error: null, durationMs: 3000 }));
      await s.view.finish();
      await shot(s.term, `resize-${settleMs}-final`);
      const lines = await s.term.logicalLines();
      const statusRows = lines.filter((l) => /esc background|esc · \^c|Running sleep|^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] /.test(l));
      assert.deepEqual(statusRows, [], `stranded live rows in scrollback:\n${lines.join('\n')}`);
      for (const n of [1, 2, 3]) {
        assert.equal(lines.filter((l) => l.startsWith(`Paragraph ${n} `)).length, 1, `Paragraph ${n} lost or duplicated:\n${lines.join('\n')}`);
      }
      const done = lines.filter((l) => l.includes('$ sleep 10'));
      assert.equal(done.length, 1, `tool row count ${done.length}:\n${lines.join('\n')}`);
    });
  }
});
