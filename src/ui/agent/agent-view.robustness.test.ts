import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { EmulatedTerminal } from '../../../test/support/emulated-terminal.js';
import { useModernWidths } from '../../../test/tools/unicode.js';
import type { ThreadEvent } from '../../protocol/schema.js';
import { AgentView, type AgentAction } from './agent-view.js';
import { formatTool } from './format.js';
import { renderHistory } from './history.js';

/*
 * Regressions from an adversarial review of the inline UI: input that must
 * not answer prompts, resizes, CPU after big output, teardown, and turns
 * that end without turn.ended.
 */

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
let seq = 0;
const event = (partial: Record<string, unknown>): ThreadEvent => ({ seq: ++seq, turnId: 't1', ...partial }) as unknown as ThreadEvent;
const permission = event({
  type: 'permission.requested', requestId: 'p1', toolCallId: null, title: 'Run `rm -rf build`',
  options: [
    { optionId: 'once', name: 'Allow once', kind: 'allow_once' },
    { optionId: 'no', name: 'Reject', kind: 'reject_once' },
  ],
});

let view: AgentView | undefined;
afterEach(() => {
  view?.destroy();
  view = undefined;
});

const setup = async (cols: number, rows: number) => {
  const term = new EmulatedTerminal(cols, rows);
  useModernWidths(term.terminal);
  term.write('~/acme $ :: question\r\n');
  view = new AgentView(term, 'ansi256', { agentName: 'claude', cwd: '/home/dev/acme', home: '/home/dev' });
  const actions: AgentAction[] = [];
  view.onAction((action) => actions.push(action));
  view.start(await term.cursor());
  view.apply(event({ type: 'turn.started', text: 'q', at: Date.now() }));
  return { term, view, actions };
};

const waitForScreen = async (term: EmulatedTerminal, predicate: (lines: string[]) => boolean): Promise<void> => {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate(await term.screen())) {
      return;
    }
    await sleep(20);
  }
  throw new Error(`timed out; screen:\n${(await term.screen()).join('\n')}`);
};

/** A prompt that has been on screen long enough to take keys. */
const armedPrompt = async () => {
  const context = await setup(80, 24);
  context.view.apply(permission);
  await waitForScreen(context.term, (lines) => lines.some((line) => line.includes('wants to')));
  await sleep(350);
  return context;
};

describe('a permission prompt takes only deliberate keys', () => {
  it('ignores a bracketed paste, even one split across reads, that contains y', async () => {
    const { view, actions } = await armedPrompt();
    assert.equal(view.handleInput('\u001b[200~hey, why is this slow?\u001b[201~'), true);
    view.handleInput('\u001b[200~yes y');
    view.handleInput('\r y\u001b[201~');
    assert.deepEqual(actions, []);
    view.handleInput('y');
    assert.deepEqual(actions, [{ type: 'answer', requestId: 'p1', optionId: 'once' }], 'a typed y still answers');
  });

  it('ignores typed-ahead text arriving as one burst', async () => {
    const { view, actions } = await armedPrompt();
    assert.equal(view.handleInput('git status\r'), true);
    assert.deepEqual(actions, []);
  });

  it('ignores keys in the first moments after the prompt appears', async () => {
    const { term, view, actions } = await setup(80, 24);
    view.apply(permission);
    await waitForScreen(term, (lines) => lines.some((line) => line.includes('wants to')));
    view.handleInput('\r');
    assert.deepEqual(actions, [], 'an Enter meant for the shell answered the prompt');
  });

  it('waits for the rest of an escape sequence split across reads', async () => {
    const { view, actions } = await armedPrompt();
    view.handleInput('\u001b');
    view.handleInput('[C');
    await sleep(60);
    assert.deepEqual(actions, [], 'the split arrow key was taken for Esc');
    view.handleInput('\r');
    assert.deepEqual(actions, [{ type: 'answer', requestId: 'p1', optionId: 'no' }]);
  });
});

describe('a resize mid-stream', () => {
  const paragraphs = Array.from({ length: 3 }, (_, index) => `Paragraph ${index + 1} explains a part of the change in a sentence long enough to wrap.`).join('\n\n');

  for (const settleMs of [60, 200]) {
    it(`keeps committed text whole when relayout comes ${settleMs} ms after the resize`, async () => {
      const { term, view } = await setup(90, 16);
      view.apply(event({ type: 'tool.updated', tool: { id: 'a', title: 'pnpm test', kind: 'execute', status: 'completed', locations: [], content: [] } }));
      view.apply(event({ type: 'message.chunk', messageId: 'm', kind: 'text', text: paragraphs }));
      view.apply(event({ type: 'tool.updated', tool: { id: 'b', title: 'sleep 10', kind: 'execute', status: 'in_progress', locations: [], content: [] } }));
      await sleep(200);
      // xterm.js parses writes asynchronously; a real terminal has drawn everything before the user drags it.
      await term.flush();
      term.resize(50, 16);
      const writtenAtResize = term.output().length;
      await sleep(settleMs);
      assert.equal(term.output().length, writtenAtResize, 'painted before relayout, at the old width');
      await view.relayout();
      await sleep(150);
      view.apply(event({ type: 'tool.updated', tool: { id: 'b', title: 'sleep 10', kind: 'execute', status: 'completed', locations: [], content: [] } }));
      view.apply(event({ type: 'turn.ended', stopReason: 'end_turn', error: null, durationMs: 3000 }));
      await view.finish();
      const lines = await term.logicalLines();
      for (const n of [1, 2, 3]) {
        assert.equal(lines.filter((line) => line.startsWith(`Paragraph ${n} `)).length, 1, `Paragraph ${n} lost or doubled:\n${lines.join('\n')}`);
      }
      assert.equal(lines.filter((line) => line.includes('$ sleep 10')).length, 1, lines.join('\n'));
      assert.ok(!lines.some((line) => /esc background|Running/.test(line)), `live rows stranded:\n${lines.join('\n')}`);
      assert.ok(!lines.some((line, index) => line === '' && lines[index + 1] === ''), `a doubled blank row:\n${lines.join('\n')}`);
    });
  }

  it('keeps the live region in place through a narrowing and then a widening resize', async () => {
    const { term, view } = await setup(90, 16);
    view.apply(event({ type: 'message.chunk', messageId: 'm', kind: 'text', text: paragraphs }));
    view.apply(event({ type: 'tool.updated', tool: { id: 'b', title: 'sleep 10', kind: 'execute', status: 'in_progress', locations: [], content: [] } }));
    await sleep(200);
    for (const cols of [50, 120, 40]) {
      await term.flush();
      term.resize(cols, 16);
      await view.relayout();
      await sleep(150);
    }
    view.apply(event({ type: 'tool.updated', tool: { id: 'b', title: 'sleep 10', kind: 'execute', status: 'completed', locations: [], content: [] } }));
    view.apply(event({ type: 'turn.ended', stopReason: 'end_turn', error: null, durationMs: 3000 }));
    await view.finish();
    const lines = await term.logicalLines();
    assert.equal(lines.filter((line) => line.includes('$ sleep 10')).length, 1, lines.join('\n'));
    assert.ok(!lines.some((line) => /esc|Running/.test(line)), lines.join('\n'));
    for (const n of [1, 2, 3]) {
      assert.equal(lines.filter((line) => line.startsWith(`Paragraph ${n} `)).length, 1, lines.join('\n'));
    }
  });

  it('leaves no extra blank row when only the status line is live', async () => {
    const { term, view } = await setup(90, 16);
    view.apply(event({ type: 'message.chunk', messageId: 'm', kind: 'text', text: paragraphs }));
    view.apply(event({ type: 'tool.updated', tool: { id: 'b', title: 'sleep 10', kind: 'execute', status: 'completed', locations: [], content: [] } }));
    await sleep(200);
    await term.flush();
    term.resize(50, 16);
    await view.relayout();
    await sleep(150);
    view.apply(event({ type: 'turn.ended', stopReason: 'end_turn', error: null, durationMs: 3000 }));
    await view.finish();
    const lines = await term.logicalLines();
    assert.ok(!lines.some((line, index) => line === '' && lines[index + 1] === ''), `a doubled blank row:\n${lines.join('\n')}`);
  });
});

describe('cost after big output', { timeout: 60_000 }, () => {
  it('draws into a small buffer again once a 5,000-line block is in scrollback', async () => {
    const { term, view } = await setup(100, 30);
    const code = Array.from({ length: 5000 }, (_, index) => `const value${index} = compute(${index});`).join('\n');
    view.apply(event({ type: 'message.chunk', messageId: 'm', kind: 'text', text: `\`\`\`ts\n${code}` }));
    await sleep(300);
    view.apply(event({ type: 'message.chunk', messageId: 'm', kind: 'text', text: '\n```\n\nDone.' }));
    view.apply(event({ type: 'tool.updated', tool: { id: 't', title: 'sleep 60', kind: 'execute', status: 'in_progress', locations: [], content: [] } }));
    await waitForScreen(term, (lines) => lines.some((line) => line.includes('Running sleep 60')));
    await sleep(300);
    assert.ok((view as unknown as { bufferRows: number }).bufferRows <= 60, 'the buffer stayed 5,000 rows tall');
    const before = process.cpuUsage();
    await sleep(1000);
    const used = process.cpuUsage(before);
    const share = (used.user + used.system) / 1000 / 1000;
    assert.ok(share < 0.3, `the idle spinner costs ${(share * 100).toFixed(0)}% of a core`);
  });

  it('counts OpenTUI drawing in the frame cost', async () => {
    const { view } = await setup(100, 30);
    const code = Array.from({ length: 3000 }, (_, index) => `line ${index}`).join('\n');
    view.apply(event({ type: 'message.chunk', messageId: 'm', kind: 'text', text: `\`\`\`\n${code}` }));
    await sleep(400);
    assert.ok(view.renderStats.averageFrameMs > 1, `frames reported at ${view.renderStats.averageFrameMs} ms`);
  });

  it('redraws a waiting prompt about once a second, not every spinner frame', async () => {
    const { view } = await armedPrompt();
    const before = view.renderStats.frames;
    await sleep(1100);
    const frames = view.renderStats.frames - before;
    assert.ok(frames <= 3, `${frames} frames in a second of waiting`);
  });

  it('formats a running edit with a big diff cheaply on every spinner frame', () => {
    const before = Array.from({ length: 1400 }, (_, index) => `line ${index}`).join('\n');
    const after = Array.from({ length: 1400 }, (_, index) => `line ${index} changed`).join('\n');
    const tool = { id: 'x', title: 'Edit a.ts', kind: 'edit', status: 'in_progress', locations: [], content: [{ type: 'diff', path: '/a.ts', oldText: before, newText: after, truncated: false }] } as never;
    const context = { cwd: '/', home: '/h', width: 100, agentName: 'claude', spinner: '⠋' };
    for (let frame = 0; frame < 3; frame++) {
      const started = performance.now();
      formatTool(tool, context);
      const elapsed = performance.now() - started;
      assert.ok(elapsed < 16, `frame ${frame}: ${elapsed.toFixed(0)} ms`);
    }
  });

  it('lays out only the start of a very long answer for history', async () => {
    const answer = Array.from({ length: 20_000 }, (_, index) => `Line ${index} of a very long answer.`).join('\n\n');
    const events = [
      event({ type: 'turn.started', text: 'q', at: 0 }),
      event({ type: 'message.chunk', messageId: 'm', kind: 'text', text: answer }),
      event({ type: 'turn.ended', stopReason: 'end_turn', error: null, durationMs: 1 }),
    ];
    const started = performance.now();
    const text = await renderHistory(events, { agentName: 'claude', title: 't', updatedAt: 0, cwd: '/', home: '/h', width: 100, colorDepth: 'ansi256' });
    const elapsed = performance.now() - started;
    assert.ok(elapsed < 500, `${elapsed.toFixed(0)} ms`);
    assert.match(text, /… \(\d{4,} more lines\)/);
  });
});

describe('teardown and early finish', () => {
  const cursorHidden = (output: string): boolean => output.lastIndexOf('\u001b[?25l') > output.lastIndexOf('\u001b[?25h');

  it('destroy() mid-turn leaves no live rows and a visible cursor', async () => {
    const { term, view } = await setup(80, 12);
    view.apply(event({ type: 'message.chunk', messageId: 'm', kind: 'text', text: 'streaming' }));
    await waitForScreen(term, (lines) => lines.some((line) => line.includes('esc background')));
    view.destroy();
    assert.ok(!cursorHidden(term.output()), 'cursor left hidden');
    assert.ok(!(await term.screen()).some((line) => line.includes('esc background')), 'status line left on screen');
  });

  it('finish() before turn.ended keeps what was shown, running tools as stopped', async () => {
    const { term, view } = await setup(80, 20);
    view.apply(event({ type: 'message.chunk', messageId: 'm', kind: 'text', text: 'First paragraph, complete.\n\nSecond paragraph, still stream' }));
    view.apply(event({ type: 'tool.updated', tool: { id: 'b', title: 'make', kind: 'execute', status: 'in_progress', locations: [], content: [] } }));
    await sleep(200);
    await view.finish();
    const lines = await term.allLines();
    assert.ok(lines.includes('First paragraph, complete.'), lines.join('\n'));
    assert.ok(lines.includes('Second paragraph, still stream'), lines.join('\n'));
    assert.ok(lines.includes('◼ $ make'), lines.join('\n'));
  });
});

describe('narrow terminals', () => {
  it('fits the "more lines above" note into 40 columns', async () => {
    const { term, view } = await setup(40, 12);
    const code = Array.from({ length: 40 }, (_, index) => `line ${index}`).join('\n');
    view.apply(event({ type: 'message.chunk', messageId: 'm', kind: 'text', text: `Here:\n\n\`\`\`ts\n${code}` }));
    await waitForScreen(term, (lines) => lines.some((line) => line.includes('⋮')));
    const buffer = term.terminal.buffer.active;
    const wrapped = Array.from({ length: buffer.length }, (_, index) => buffer.getLine(index)).filter((line) => line?.isWrapped).length;
    assert.equal(wrapped, 0, (await term.screen()).join('\n'));
  });
});
