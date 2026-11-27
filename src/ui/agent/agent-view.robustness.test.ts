import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { EmulatedTerminal } from '../../../test/support/emulated-terminal.js';
import { useModernWidths } from '../../../test/tools/unicode.js';
import type { ThreadEvent } from '../../protocol/schema.js';
import { AgentView, type AgentAction, type ViewTimers } from './agent-view.js';
import { diffOf } from './diff.js';
import { renderHistory } from './history.js';

/*
 * Regressions from reviews of the inline UI: input that must not answer
 * prompts, resizes (missed ones included), cost after big output, teardown,
 * and turns that end without turn.ended.
 *
 * Nothing here depends on wall-clock speed: the view gets a fake clock and
 * fake timers, and assertions count things rather than time them. Timing
 * checks live in scripts/ui-perf-check.ts.
 */

/** Fake timers the test fires by hand, and a clock it moves by hand. */
class FakeTimers implements ViewTimers {
  now = 1_000_000;
  private next = 1;
  readonly pending = new Map<number, { callback: () => void; at: number; every?: number }>();

  setTimeout(callback: () => void, ms: number): unknown {
    const id = this.next++;
    this.pending.set(id, { callback, at: this.now + ms });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.pending.delete(handle as number);
  }

  setInterval(callback: () => void, ms: number): unknown {
    const id = this.next++;
    this.pending.set(id, { callback, at: this.now + ms, every: ms });
    return id;
  }

  clearInterval(handle: unknown): void {
    this.pending.delete(handle as number);
  }

  /** Move the clock on, firing every timer that falls due, in order. */
  advance(ms: number): void {
    const end = this.now + ms;
    for (;;) {
      const due = [...this.pending.entries()].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) {
        break;
      }
      const [id, timer] = due;
      this.now = timer.at;
      if (timer.every) {
        timer.at += timer.every;
      } else {
        this.pending.delete(id);
      }
      timer.callback();
    }
    this.now = end;
  }
}

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
const paragraphs = Array.from({ length: 3 }, (_, index) => `Paragraph ${index + 1} explains a part of the change in a sentence long enough to wrap.`).join('\n\n');

let view: AgentView | undefined;
afterEach(() => {
  view?.destroy();
  view = undefined;
});

interface SetupOptions {
  readonly reflow?: boolean;
  /** Replace the terminal's cursor query, e.g. with one that fails. */
  readonly query?: () => Promise<{ row: number; col: number }>;
}

const setup = async (cols: number, rows: number, options: SetupOptions = {}) => {
  const term = new EmulatedTerminal(cols, rows, { reflow: options.reflow ?? true });
  useModernWidths(term.terminal);
  term.write('~/acme $ :: question\r\n');
  const timers = new FakeTimers();
  const host = options.query
    ? { get size() { return term.size; }, write: term.write, queryCursorPosition: options.query }
    : term;
  view = new AgentView(host, 'ansi256', { agentName: 'claude', cwd: '/home/dev/acme', home: '/home/dev', now: () => timers.now, timers });
  const actions: AgentAction[] = [];
  view.onAction((action) => actions.push(action));
  view.start(await term.cursor());
  view.apply(event({ type: 'turn.started', text: 'q', at: timers.now }));
  return { term, view, actions, timers };
};

/** Poll until the frames in flight have been drawn (no timing assumption: it waits as long as it takes). */
const waitForScreen = async (term: EmulatedTerminal, predicate: (lines: string[]) => boolean): Promise<void> => {
  for (let attempt = 0; attempt < 500; attempt++) {
    if (predicate(await term.screen())) {
      return;
    }
    await sleep(10);
  }
  throw new Error(`timed out; screen:\n${(await term.screen()).join('\n')}`);
};

const settle = async (term: EmulatedTerminal): Promise<void> => {
  let last = -1;
  for (let attempt = 0; attempt < 500 && term.output().length !== last; attempt++) {
    last = term.output().length;
    await sleep(30);
  }
};

/** A prompt on screen whose arming delay has passed on the fake clock. */
const armedPrompt = async () => {
  const context = await setup(80, 24);
  context.view.apply(permission);
  await waitForScreen(context.term, (lines) => lines.some((line) => line.includes('wants to')));
  context.timers.now += 400;
  return context;
};

describe('a permission prompt takes only deliberate keys', () => {
  it('hands a bracketed paste back, even one split across reads, and never answers from it', async () => {
    const { view, actions } = await armedPrompt();
    assert.equal(view.handleInput('\u001b[200~hey, why is this slow?\u001b[201~'), false, 'the paste is handed back for the shell');
    assert.equal(view.handleInput('\u001b[200~yes y'), false);
    assert.equal(view.handleInput('\r y\u001b[201~'), false);
    assert.deepEqual(actions, []);
    assert.equal(view.handleInput('y'), true);
    assert.deepEqual(actions, [{ type: 'answer', requestId: 'p1', optionId: 'once' }], 'a typed y still answers');
  });

  it('gives up on a paste whose end marker never comes', async () => {
    const { view, actions, timers } = await armedPrompt();
    view.handleInput('\u001b[200~pasted text, end marker lost');
    timers.now += 600;
    view.handleInput('y');
    assert.deepEqual(actions, [{ type: 'answer', requestId: 'p1', optionId: 'once' }]);
  });

  it('hands typed-ahead text arriving as one burst back, unanswered', async () => {
    const { view, actions } = await armedPrompt();
    assert.equal(view.handleInput('git status\r'), false);
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
    const { view, actions, timers } = await armedPrompt();
    view.handleInput('\u001b');
    view.handleInput('[C');
    timers.advance(100);
    assert.deepEqual(actions, [], 'the split arrow key was taken for Esc');
    view.handleInput('\r');
    assert.deepEqual(actions, [{ type: 'answer', requestId: 'p1', optionId: 'no' }]);
  });

  it('takes a lone Esc as Esc once the wait is over', async () => {
    const { view, actions, timers } = await armedPrompt();
    view.handleInput('\u001b');
    timers.advance(100);
    assert.deepEqual(actions, [{ type: 'answer', requestId: 'p1', optionId: 'no' }]);
  });

  for (const [label, read] of [['alone', '\u0003'], ['amid other keys', 'ab\u0003c'], ['right after a paste in the same read', '\u001b[200~pasted\u001b[201~\u0003']] as const) {
    it(`always stops on a typed Ctrl-C ${label}, prompt open or not`, async () => {
      const { view, actions } = await armedPrompt();
      assert.equal(view.handleInput(read), true);
      assert.deepEqual(actions, [{ type: 'cancel' }]);
    });
  }

  it('does not stop on a 0x03 byte inside a paste, and keeps following the paste', async () => {
    const { view, actions } = await armedPrompt();
    assert.equal(view.handleInput('\u001b[200~binary \u0003 log'), false);
    assert.equal(view.handleInput('y and more \u0003\u001b[201~'), false, 'the rest of the paste is still pasted text');
    assert.deepEqual(actions, []);
  });
});

describe('a resize mid-stream', () => {
  const streamWithLiveTool = async (term: EmulatedTerminal, view: AgentView) => {
    view.apply(event({ type: 'tool.updated', tool: { id: 'a', title: 'pnpm test', kind: 'execute', status: 'completed', locations: [], content: [] } }));
    view.apply(event({ type: 'message.chunk', messageId: 'm', kind: 'text', text: paragraphs }));
    view.apply(event({ type: 'tool.updated', tool: { id: 'b', title: 'sleep 10', kind: 'execute', status: 'in_progress', locations: [], content: [] } }));
    await waitForScreen(term, (lines) => lines.some((line) => line.includes('Running sleep 10')));
    await settle(term);
  };

  const endTurn = async (view: AgentView) => {
    view.apply(event({ type: 'tool.updated', tool: { id: 'b', title: 'sleep 10', kind: 'execute', status: 'completed', locations: [], content: [] } }));
    view.apply(event({ type: 'turn.ended', stopReason: 'end_turn', error: null, durationMs: 3000 }));
    await view.finish();
  };

  const assertWhole = (lines: string[]): void => {
    for (const n of [1, 2, 3]) {
      assert.equal(lines.filter((line) => line.startsWith(`Paragraph ${n} `)).length, 1, `Paragraph ${n} lost or doubled:\n${lines.join('\n')}`);
    }
    assert.equal(lines.filter((line) => line.includes('$ sleep 10')).length, 1, lines.join('\n'));
    assert.ok(!lines.some((line) => /esc background|Running/.test(line)), `live rows stranded:\n${lines.join('\n')}`);
    assert.ok(!lines.some((line, index) => line === '' && lines[index + 1] === ''), `a doubled blank row:\n${lines.join('\n')}`);
  };

  it('paints nothing between the resize and relayout(), then keeps committed text whole', async () => {
    const { term, view } = await setup(90, 16);
    await streamWithLiveTool(term, view);
    term.resize(50, 16);
    const writtenAtResize = term.output().length;
    // An update arrives before relayout: it must wait for it.
    view.apply(event({ type: 'message.chunk', messageId: 'm2', kind: 'text', text: 'More.' }));
    await sleep(100);
    assert.equal(term.output().length, writtenAtResize, 'painted at the old anchor after a resize');
    await view.relayout();
    await endTurn(view);
    assertWhole(await term.logicalLines());
  });

  it('relays out by itself once a resize nobody passed on has settled', async () => {
    const { term, view, timers } = await setup(90, 16);
    await streamWithLiveTool(term, view);
    term.resize(50, 16);
    timers.advance(80);
    await sleep(20);
    timers.advance(200);
    await waitForScreen(term, (lines) => lines.some((line) => line.includes('Running sleep 10') && line.length <= 50));
    await endTurn(view);
    assertWhole(await term.logicalLines());
  });

  it('commits the final output when finish() comes after a resize nobody relaid out for', async () => {
    const { term, view } = await setup(90, 16);
    await streamWithLiveTool(term, view);
    term.resize(50, 16);
    await endTurn(view);
    const lines = await term.logicalLines();
    assertWhole(lines);
    assert.match(lines.at(-1)!, /^✓ /);
  });

  it('keeps the live region in place through a narrowing and then a widening resize', async () => {
    const { term, view } = await setup(90, 16);
    await streamWithLiveTool(term, view);
    for (const cols of [50, 120, 40]) {
      term.resize(cols, 16);
      await view.relayout();
      await settle(term);
    }
    await endTurn(view);
    assertWhole(await term.logicalLines());
  });

  it('leaves no extra blank row when only the status line is live', async () => {
    const { term, view } = await setup(90, 16);
    view.apply(event({ type: 'message.chunk', messageId: 'm', kind: 'text', text: paragraphs }));
    view.apply(event({ type: 'tool.updated', tool: { id: 'b', title: 'sleep 10', kind: 'execute', status: 'completed', locations: [], content: [] } }));
    await waitForScreen(term, (lines) => lines.some((line) => line.includes('esc background')));
    await settle(term);
    term.resize(50, 16);
    await view.relayout();
    view.apply(event({ type: 'turn.ended', stopReason: 'end_turn', error: null, durationMs: 3000 }));
    await view.finish();
    const lines = await term.logicalLines();
    assert.ok(!lines.some((line, index) => line === '' && lines[index + 1] === ''), `a doubled blank row:\n${lines.join('\n')}`);
  });

  it('never paints over committed text when the cursor query fails', async () => {
    const { term, view } = await setup(90, 16, { query: () => Promise.reject(new Error('no answer')) });
    await streamWithLiveTool(term, view);
    term.resize(50, 16);
    await view.relayout();
    await endTurn(view);
    const lines = await term.logicalLines();
    for (const n of [1, 2, 3]) {
      assert.equal(lines.filter((line) => line.startsWith(`Paragraph ${n} `)).length, 1, `Paragraph ${n} lost:\n${lines.join('\n')}`);
    }
    assert.ok(lines.includes('● $ pnpm test'), lines.join('\n'));
  });

  it('keeps committed text whole in a terminal that does not reflow', async () => {
    const { term, view } = await setup(90, 16, { reflow: false });
    await streamWithLiveTool(term, view);
    term.resize(50, 16);
    await view.relayout();
    await endTurn(view);
    // Rows are cut at the new width rather than rewrapped; each paragraph's start is still there once.
    const lines = await term.allLines();
    for (const n of [1, 2, 3]) {
      assert.equal(lines.filter((line) => line.startsWith(`Paragraph ${n} `)).length, 1, `Paragraph ${n} lost:\n${lines.join('\n')}`);
    }
    assert.equal(lines.filter((line) => line.includes('$ sleep 10')).length, 1, lines.join('\n'));
    assert.ok(!lines.some((line) => /esc background|Running/.test(line)), lines.join('\n'));
  });

  it('re-anchors correctly around wide characters that wrap', async () => {
    const { term, view } = await setup(90, 16);
    const wide = `${'漢字'.repeat(20)}末`;
    view.apply(event({ type: 'message.chunk', messageId: 'm', kind: 'text', text: `${wide}\n\nstill streaming ${'漢'.repeat(30)}` }));
    view.apply(event({ type: 'tool.updated', tool: { id: 'b', title: 'sleep 10', kind: 'execute', status: 'in_progress', locations: [], content: [] } }));
    await waitForScreen(term, (lines) => lines.some((line) => line.includes('Running sleep 10')));
    await settle(term);
    term.resize(47, 16);
    await view.relayout();
    await endTurn(view);
    const lines = await term.logicalLines();
    assert.equal(lines.filter((line) => line.startsWith('漢字漢字')).length, 1, lines.join('\n'));
    assert.equal(lines.filter((line) => line.includes('$ sleep 10')).length, 1, lines.join('\n'));
    assert.ok(!lines.some((line) => /esc background|Running/.test(line)), lines.join('\n'));
  });
});

describe('cost after big output', { timeout: 60_000 }, () => {
  it('draws into a small buffer again once a 5,000-line block is in scrollback', async () => {
    const { term, view } = await setup(100, 30);
    const code = Array.from({ length: 5000 }, (_, index) => `const value${index} = compute(${index});`).join('\n');
    view.apply(event({ type: 'message.chunk', messageId: 'm', kind: 'text', text: `\`\`\`ts\n${code}` }));
    await waitForScreen(term, (lines) => lines.some((line) => line.includes('value4999')));
    view.apply(event({ type: 'message.chunk', messageId: 'm', kind: 'text', text: '\n```\n\nDone.' }));
    view.apply(event({ type: 'tool.updated', tool: { id: 't', title: 'sleep 60', kind: 'execute', status: 'in_progress', locations: [], content: [] } }));
    await waitForScreen(term, (lines) => lines.some((line) => line.includes('Running sleep 60')));
    await settle(term);
    assert.ok((view as unknown as { bufferRows: number }).bufferRows <= 60, 'the buffer stayed 5,000 rows tall: every frame redraws it all');
  });

  it('redraws a waiting prompt about once a second, not every spinner frame', async () => {
    const { term, view, timers } = await armedPrompt();
    await settle(term);
    const before = view.renderStats.frames;
    // A second of spinner ticks, each given time to draw if it asks to.
    for (let tick = 0; tick < 12; tick++) {
      timers.advance(80);
      await sleep(15);
    }
    await settle(term);
    const frames = view.renderStats.frames - before;
    assert.ok(frames <= 2, `${frames} frames for a second of waiting`);
  });

  it('works out a running edit\'s diff once, not on every spinner frame', () => {
    const content = { type: 'diff' as const, path: '/a.ts', oldText: 'a\nb\n', newText: 'a\nc\n', truncated: false };
    assert.equal(diffOf(content), diffOf(content));
  });

  it('counts the rest of a long answer in history without showing it', async () => {
    const answer = Array.from({ length: 2000 }, (_, index) => `Line ${index} of a long answer.`).join('\n\n');
    const text = await renderHistory([
      event({ type: 'turn.started', text: 'q', at: 0 }),
      event({ type: 'message.chunk', messageId: 'm', kind: 'text', text: answer }),
      event({ type: 'turn.ended', stopReason: 'end_turn', error: null, durationMs: 1 }),
    ], { agentName: 'claude', title: 't', updatedAt: 0, cwd: '/', home: '/h', width: 100, colorDepth: 'ansi256' });
    const more = /… \((\d+) more lines\)/.exec(text);
    assert.ok(more && Number(more[1]) > 1900, String(more?.[0]));
  });
});

describe('teardown and early finish', () => {
  it('finish() stops cleanly when destroy() runs while its relayout waits for the cursor', async () => {
    let answer: (position: { row: number; col: number }) => void = () => {};
    const { term, view } = await setup(90, 16, { query: () => new Promise((resolve) => { answer = resolve; }) });
    view.apply(event({ type: 'message.chunk', messageId: 'm', kind: 'text', text: 'streaming' }));
    await waitForScreen(term, (lines) => lines.some((line) => line.includes('esc background')));
    await settle(term);
    term.resize(60, 16);
    const finishing = view.finish();
    view.destroy();
    const writtenAtDestroy = term.output().length;
    answer({ row: 3, col: 1 });
    const outcome = await Promise.race([finishing.then(() => 'done'), sleep(1500).then(() => 'stalled')]);
    assert.equal(outcome, 'done', 'finish() waited out its timeout on a destroyed view');
    assert.equal(term.output().length, writtenAtDestroy, 'wrote to the terminal after destroy()');
  });

  it('finish() writes nothing more when destroy() runs while it waits for the last frames', async () => {
    const { term, view } = await setup(80, 12);
    view.apply(event({ type: 'message.chunk', messageId: 'm', kind: 'text', text: 'streaming' }));
    await waitForScreen(term, (lines) => lines.some((line) => line.includes('esc background')));
    const finishing = view.finish();
    view.destroy();
    const writtenAtDestroy = term.output().length;
    await finishing;
    await settle(term);
    assert.equal(term.output().length, writtenAtDestroy);
  });

  const cursorHidden = (output: string): boolean => output.lastIndexOf('\u001b[?25l') > output.lastIndexOf('\u001b[?25h');

  it('destroy() mid-turn leaves no live rows and a visible cursor', async () => {
    const { term, view } = await setup(80, 12);
    view.apply(event({ type: 'message.chunk', messageId: 'm', kind: 'text', text: 'streaming' }));
    await waitForScreen(term, (lines) => lines.some((line) => line.includes('esc background')));
    view.destroy();
    assert.ok(!cursorHidden(term.output()), 'cursor left hidden');
    assert.ok(!(await term.screen()).some((line) => line.includes('esc background')), 'status line left on screen');
  });

  it('destroy() after a resize nobody relaid out for still clears the live rows', async () => {
    const { term, view } = await setup(90, 16);
    view.apply(event({ type: 'message.chunk', messageId: 'm', kind: 'text', text: 'streaming' }));
    await waitForScreen(term, (lines) => lines.some((line) => line.includes('esc background')));
    await settle(term);
    term.resize(60, 16);
    view.destroy();
    assert.ok(!cursorHidden(term.output()), 'cursor left hidden');
    assert.ok(!(await term.screen()).some((line) => line.includes('esc')), (await term.screen()).join('\n'));
  });

  it('finish() before turn.ended keeps what was shown, running tools as stopped', async () => {
    const { term, view } = await setup(80, 20);
    view.apply(event({ type: 'message.chunk', messageId: 'm', kind: 'text', text: 'First paragraph, complete.\n\nSecond paragraph, still stream' }));
    view.apply(event({ type: 'tool.updated', tool: { id: 'b', title: 'make', kind: 'execute', status: 'in_progress', locations: [], content: [] } }));
    await waitForScreen(term, (lines) => lines.some((line) => line.includes('make')));
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
    const note = (await term.screen()).find((line) => line.includes('⋮'))!;
    assert.ok(note.length <= 40 && note.endsWith('…'), JSON.stringify(note));
  });
});
