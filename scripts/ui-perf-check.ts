/*
 * Timing checks for the inline UI, with tight bounds. They measure wall
 * time and CPU, so they are kept out of the default test suite (a loaded CI
 * machine would make them flake); run them on a quiet machine:
 *
 *   pnpm perf:ui
 *
 * Exits non-zero if any check fails.
 */
import { setTimeout as sleep } from 'node:timers/promises';
import type { ThreadEvent } from '../src/protocol/schema.js';
import { sanitizeTerminalText } from '../src/render/sanitize.js';
import { AgentView } from '../src/ui/agent/agent-view.js';
import { formatTool } from '../src/ui/agent/format.js';
import { renderHistory } from '../src/ui/agent/history.js';
import { loadFixture } from '../test/fixtures/thread-events/load.js';
import { EmulatedTerminal } from '../test/support/emulated-terminal.js';
import { playFixture } from '../test/support/play.js';

let failures = 0;
const check = (name: string, ok: boolean, detail: string): void => {
  console.log(`${ok ? '✔' : '✖'} ${name}: ${detail}`);
  if (!ok) {
    failures++;
  }
};

let seq = 0;
const event = (partial: Record<string, unknown>): ThreadEvent => ({ seq: ++seq, turnId: 't', ...partial }) as unknown as ThreadEvent;

const view = async (cols: number, rows: number) => {
  const term = new EmulatedTerminal(cols, rows);
  const agent = new AgentView(term, 'ansi256', { agentName: 'claude', cwd: '/', home: '/h' });
  agent.start({ row: 1, col: 1 });
  agent.apply(event({ type: 'turn.started', text: 'q', at: Date.now() }));
  return { term, agent };
};

const cpuShare = async (ms: number): Promise<number> => {
  const before = process.cpuUsage();
  await sleep(ms);
  const used = process.cpuUsage(before);
  return (used.user + used.system) / 1000 / ms;
};

// Sanitizer: linear on unterminated introducers.
for (const [label, introducer] of [['C1 DCS', '\u0090'], ['C1 OSC', '\u009d'], ['ESC ]', '\u001b]']] as const) {
  const started = performance.now();
  sanitizeTerminalText(`${introducer}x`.repeat(40_000));
  const elapsed = performance.now() - started;
  check(`sanitize 40,000 unterminated ${label}`, elapsed < 150, `${elapsed.toFixed(1)} ms`);
}

// A running edit with a big diff: cheap on every spinner frame.
{
  const before = Array.from({ length: 1400 }, (_, index) => `line ${index}`).join('\n');
  const after = Array.from({ length: 1400 }, (_, index) => `line ${index} changed`).join('\n');
  const tool = { id: 'x', title: 'Edit a.ts', kind: 'edit', status: 'in_progress', locations: [], content: [{ type: 'diff', path: '/a.ts', oldText: before, newText: after, truncated: false }] } as never;
  const context = { cwd: '/', home: '/h', width: 100, agentName: 'claude', spinner: '⠋' };
  const times = Array.from({ length: 3 }, () => {
    const started = performance.now();
    formatTool(tool, context);
    return performance.now() - started;
  });
  check('format a 1,400-line edit per frame', Math.max(...times) < 16, times.map((time) => `${time.toFixed(1)} ms`).join(', '));
}

// History of a very long answer.
{
  const answer = Array.from({ length: 20_000 }, (_, index) => `Line ${index}.`).join('\n\n');
  const started = performance.now();
  await renderHistory([
    event({ type: 'turn.started', text: 'q', at: 0 }),
    event({ type: 'message.chunk', messageId: 'm', kind: 'text', text: answer }),
    event({ type: 'turn.ended', stopReason: 'end_turn', error: null, durationMs: 1 }),
  ], { agentName: 'claude', title: 't', updatedAt: 0, cwd: '/', home: '/h', width: 100, colorDepth: 'ansi256' });
  const elapsed = performance.now() - started;
  check('history of a 20,000-paragraph answer', elapsed < 300, `${elapsed.toFixed(0)} ms`);
}

// First paint and frame cost while a long answer streams.
{
  const fixture = loadFixture('long-answer');
  const { agent } = await view(100, 30);
  await playFixture(agent, fixture, 25);
  await agent.finish();
  const stats = agent.renderStats;
  check('first paint', stats.firstPaintMs < 100, `${stats.firstPaintMs} ms`);
  check('average frame while streaming', stats.averageFrameMs < 20, `${stats.averageFrameMs.toFixed(1)} ms over ${stats.frames} frames`);
  agent.destroy();
}

// Frame stats include OpenTUI's drawing: compare with CPU while a big block is open.
{
  const { agent } = await view(100, 30);
  agent.apply(event({ type: 'message.chunk', messageId: 'm', kind: 'text', text: `\`\`\`\n${Array.from({ length: 3000 }, (_, index) => `line ${index}`).join('\n')}` }));
  await sleep(400);
  const before = agent.renderStats;
  const cpuBefore = process.cpuUsage();
  await sleep(1000);
  const cpu = process.cpuUsage(cpuBefore);
  const after = agent.renderStats;
  const reported = after.averageFrameMs * after.frames - before.averageFrameMs * before.frames;
  const cpuMs = (cpu.user + cpu.system) / 1000;
  check('frame stats count OpenTUI drawing', reported >= cpuMs * 0.3, `${reported.toFixed(0)} ms reported, ${cpuMs.toFixed(0)} ms CPU`);
  agent.destroy();
}

// Idle costs: after a 5,000-line block, and while a permission prompt waits.
{
  const { term, agent } = await view(100, 30);
  agent.apply(event({ type: 'message.chunk', messageId: 'm', kind: 'text', text: `\`\`\`ts\n${Array.from({ length: 5000 }, (_, index) => `const v${index} = ${index};`).join('\n')}\n\`\`\`\n\nDone.` }));
  agent.apply(event({ type: 'tool.updated', tool: { id: 't', title: 'sleep 60', kind: 'execute', status: 'in_progress', locations: [], content: [] } }));
  for (let waited = 0; waited < 10_000 && !(await term.screen()).some((line) => line.includes('Running sleep')); waited += 20) {
    await sleep(20);
  }
  await sleep(500);
  const share = await cpuShare(1500);
  check('idle spinner after a 5,000-line block', share < 0.1, `${(share * 100).toFixed(1)}% of a core`);
  agent.destroy();

  const waiting = await view(100, 30);
  waiting.agent.apply(event({ type: 'permission.requested', requestId: 'p', toolCallId: null, title: 'x', options: [{ optionId: 'a', name: 'Allow', kind: 'allow_once' }] }));
  await sleep(500);
  const waitingShare = await cpuShare(2000);
  check('waiting on a permission prompt', waitingShare < 0.05, `${(waitingShare * 100).toFixed(1)}% of a core`);
  waiting.agent.destroy();
}

console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
process.exit(failures ? 1 : 0);
