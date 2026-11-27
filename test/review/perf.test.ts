import assert from 'node:assert/strict';
import { describe, it, afterEach } from 'node:test';
import { ev, setup, sleep } from './support.js';
import type { AgentView } from '../../src/ui/agent/agent-view.js';
import { renderHistory } from '../../src/ui/agent/history.js';
import { formatTool } from '../../src/ui/agent/format.js';

let view: AgentView | undefined;
afterEach(() => { view?.destroy(); view = undefined; });

const cpuDuring = async (ms: number): Promise<number> => {
  const start = process.cpuUsage();
  await sleep(ms);
  const used = process.cpuUsage(start);
  return (used.user + used.system) / 1000 / ms; // fraction of one core
};

describe('review: performance', { timeout: 120_000 }, () => {
  it('idle while waiting on a permission prompt costs little CPU', async () => {
    const s = await setup(100, 30);
    view = s.view;
    s.view.apply(ev({ type: 'permission.requested', requestId: 'p', toolCallId: null, title: 'x', options: [{ optionId: 'a', name: 'Allow', kind: 'allow_once' }] }));
    await sleep(300);
    const cpu = await cpuDuring(2000);
    console.log(`idle (permission) CPU: ${(cpu * 100).toFixed(1)}% of a core`);
    assert.ok(cpu < 0.05, `${(cpu * 100).toFixed(1)}%`);
  });

  it('after a 5,000-line code block is committed, idle frames are cheap again', async () => {
    const s = await setup(100, 30);
    view = s.view;
    const code = Array.from({ length: 5000 }, (_, i) => `const value${i} = compute(${i}); // line ${i}`).join('\n');
    const t0 = performance.now();
    s.view.apply(ev({ type: 'message.chunk', messageId: 'm', kind: 'text', text: '```ts\n' + code }));
    await sleep(100);
    // Stream a little more, one chunk per 50 ms, while the block is still open.
    for (let i = 0; i < 10; i++) {
      s.view.apply(ev({ type: 'message.chunk', messageId: 'm', kind: 'text', text: `\nmore${i}` }));
      await sleep(50);
    }
    const streamingCpu = await cpuDuring(1000);
    s.view.apply(ev({ type: 'message.chunk', messageId: 'm', kind: 'text', text: '\n```\n\nDone.' }));
    s.view.apply(ev({ type: 'tool.updated', tool: { id: 't', title: 'sleep 60', kind: 'execute', status: 'in_progress', locations: [], content: [] } }));
    await sleep(1500);
    const idleCpu = await cpuDuring(2000);
    const stats = s.view.renderStats;
    console.log(`open 5k-line block: ${(streamingCpu * 100).toFixed(0)}% CPU; afterwards, idle spinner: ${(idleCpu * 100).toFixed(0)}% CPU; bufferRows=${(s.view as any).bufferRows}; avg frame ${stats.averageFrameMs.toFixed(1)} ms; total ${(performance.now() - t0).toFixed(0)} ms`);
    assert.ok(idleCpu < 0.1, `idle spinner after the big block burns ${(idleCpu * 100).toFixed(0)}% of a core (bufferRows=${(s.view as any).bufferRows})`);
  });

  it('1 MB of running tool output: one spinner frame of formatting', () => {
    const text = Array.from({ length: 20000 }, (_, i) => `[${i}] ${'log output '.repeat(4)}`).join('\n');
    const tool = { id: 'x', title: 'pnpm build', kind: 'execute', status: 'in_progress', locations: [], content: [{ type: 'content', content: { type: 'text', text } }] } as never;
    const ctx = { cwd: '/', home: '/h', width: 100, agentName: 'c', spinner: '⠋' };
    // match the schema's ToolContent: try both shapes
    const t1 = performance.now();
    for (let i = 0; i < 5; i++) formatTool({ ...(tool as object), content: [{ type: 'text', text }] } as never, ctx);
    const ms = (performance.now() - t1) / 5;
    console.log(`formatTool with ${(text.length / 1e6).toFixed(2)} MB output: ${ms.toFixed(1)} ms per spinner frame (every 80 ms)`);
    assert.ok(ms < 8, `${ms.toFixed(1)} ms per frame`);
  });

  it('large edit diff: formatting per spinner frame', () => {
    const before = Array.from({ length: 1400 }, (_, i) => `line ${i}`).join('\n');
    const after = Array.from({ length: 1400 }, (_, i) => `line ${i} changed`).join('\n');
    const tool = { id: 'x', title: 'Edit a.ts', kind: 'edit', status: 'in_progress', locations: [], content: [{ type: 'diff', path: '/a.ts', oldText: before, newText: after }] } as never;
    const ctx = { cwd: '/', home: '/h', width: 100, agentName: 'c', spinner: '⠋' };
    const t1 = performance.now();
    formatTool(tool, ctx);
    const ms = performance.now() - t1;
    console.log(`formatTool with a 1400×1400-line diff: ${ms.toFixed(0)} ms per spinner frame`);
    assert.ok(ms < 16, `${ms.toFixed(0)} ms`);
  });

  it('history of a 5,000-line answer renders only what it shows', async () => {
    const answer = Array.from({ length: 5000 }, (_, i) => `Line ${i} of a very long answer.`).join('\n\n');
    const events = [
      { seq: 1, type: 'turn.started', turnId: 't', text: 'q', at: 0 },
      { seq: 2, type: 'message.chunk', turnId: 't', messageId: 'm', kind: 'text', text: answer },
      { seq: 3, type: 'turn.ended', turnId: 't', stopReason: 'end_turn', error: null, durationMs: 1 },
    ] as never;
    const t1 = performance.now();
    await renderHistory(events, { agentName: 'claude', title: 't', updatedAt: 0, cwd: '/', home: '/h', width: 100, colorDepth: 'ansi256' });
    const ms = performance.now() - t1;
    console.log(`renderHistory of a 5,000-paragraph answer (shows 20 rows): ${ms.toFixed(0)} ms`);
    assert.ok(ms < 300, `${ms.toFixed(0)} ms`);
  });
});
