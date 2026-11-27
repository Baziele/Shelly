import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { loadFixture } from '../../../test/fixtures/thread-events/load.js';
import { EmulatedTerminal } from '../../../test/support/emulated-terminal.js';
import { playFixture } from '../../../test/support/play.js';
import type { ThreadEvent } from '../../protocol/schema.js';
import type { ColorDepth } from '../../render/sgr.js';
import { AgentView, type AgentAction } from './agent-view.js';

const ECHO = '~/acme-web $ :: ';

interface Setup {
  readonly term: EmulatedTerminal;
  readonly view: AgentView;
  readonly actions: AgentAction[];
}

let current: AgentView | undefined;

const setup = async (cols: number, rows: number, prompt: string, depth: ColorDepth = 'ansi256'): Promise<Setup> => {
  const term = new EmulatedTerminal(cols, rows);
  term.write(`${ECHO}${prompt}\r\n`);
  const view = new AgentView(term, depth, { agentName: 'claude', cwd: '/home/dev/acme-web', home: '/home/dev' });
  current = view;
  const actions: AgentAction[] = [];
  view.onAction((action) => actions.push(action));
  view.start(await term.cursor());
  return { term, view, actions };
};

const play = async (name: string, cols: number, rows: number, depth: ColorDepth = 'ansi256') => {
  const fixture = loadFixture(name);
  const context = await setup(cols, rows, fixture.prompt, depth);
  await playFixture(context.view, fixture, 25);
  await context.view.finish();
  return context;
};

const indexesOf = (lines: string[], pattern: RegExp): number[] =>
  lines.flatMap((line, index) => (pattern.test(line) ? [index] : []));

let seq = 1000;
const event = (partial: Record<string, unknown>): ThreadEvent => ({ seq: ++seq, turnId: 't1', ...partial }) as ThreadEvent;
const permissionRequest = event({
  type: 'permission.requested',
  requestId: 'p1',
  toolCallId: null,
  title: 'Run `make`',
  options: [
    { optionId: 'once', name: 'Allow once', kind: 'allow_once' },
    { optionId: 'always', name: 'Allow always', kind: 'allow_always' },
    { optionId: 'no', name: 'Reject', kind: 'reject_once' },
  ],
});

describe('AgentView', { timeout: 30_000 }, () => {
  afterEach(() => {
    current?.destroy();
    current = undefined;
  });

  it('moves a long streamed answer into scrollback whole, in order, once', async () => {
    const { term } = await play('long-answer', 44, 20);
    const lines = await term.logicalLines();
    const headings = indexesOf(lines, /^\d\. [A-Z]/);
    assert.equal(headings.length, 8, lines.join('\n'));
    assert.deepEqual(headings, [...headings].sort((a, b) => a - b));
    assert.equal(indexesOf(lines, /^That is the whole layer/).length, 1);
    assert.equal(indexesOf(lines, /^│ export const \w+Config = load/).length, 8, 'every code block is complete');
    assert.match(lines.at(-1) ?? '', /^✓ \d+s$/);
    assert.deepEqual(await term.cursor(), { row: 20, col: 1 }, 'the cursor waits on a fresh line below everything');
  });

  it('commits tool calls with their detail, in order, and the summary last', async () => {
    const { term } = await play('tool-heavy', 100, 30);
    const lines = await term.allLines();
    const expected = [
      '✗ $ pnpm test',
      '● Read src/pages/Profile.tsx · 87 lines',
      '● Read src/profile/profile.test.ts · 40 lines',
      '● grep -rn "fetchUser(" src · 3 results',
      '· Context compacted: 48k tokens → 12k',
      '● Edit src/pages/Profile.tsx  +3 −0',
      '● $ pnpm test --filter profile',
      '! Settings.tsx also calls fetchUser() without a check; not changed.',
      '✓ 21s · 6 tools',
    ];
    const positions = expected.map((line) => lines.indexOf(line));
    assert.ok(positions.every((position) => position >= 0), `missing rows:\n${lines.join('\n')}`);
    assert.deepEqual(positions, [...positions].sort((a, b) => a - b), 'rows are in event order');
    assert.equal(lines[0], `${ECHO}run the tests and fix what fails`, 'the echoed request is untouched');
    assert.ok(!lines.some((line) => /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(line)), 'no spinner is left behind');
    assert.ok(!lines.some((line) => line.includes('esc background')), 'the status line is gone');
  });

  it('never leaves escape sequences or control characters on screen', async () => {
    for (const name of ['markdown-showcase', 'error-turn']) {
      const { term } = await play(name, 72, 24);
      for (const line of await term.allLines()) {
        assert.ok(!/\[[0-9;]*m|\u001b|[\u0000-\u0008]/.test(line), `stray escape in ${name}: ${JSON.stringify(line)}`);
      }
    }
  });

  it('writes no colours without colour support, and 16 colours at most in ansi16', async () => {
    const plain = await play('tool-heavy', 80, 24, 'none');
    assert.ok(!/\u001b\[[0-9;]*(?:3[0-9]|4[0-9]|9[0-7]|10[0-7])[;m]/.test(plain.term.output().replace(/\u001b\[0m/g, '')), 'a colour was written');
    current?.destroy();
    const sixteen = await play('tool-heavy', 80, 24, 'ansi16');
    assert.ok(!/\u001b\[[0-9;]*[34]8;[25];/.test(sixteen.term.output()), 'an extended colour was written');
  });

  it('answers a permission prompt from the keyboard and folds the answer into its tool', async () => {
    const { term, actions } = await play('permission-flow', 80, 24);
    assert.deepEqual(actions, [
      { type: 'answer', requestId: 'p1', optionId: 'allow' },
      { type: 'answer', requestId: 'p2', optionId: 'reject' },
    ]);
    const lines = await term.allLines();
    assert.ok(lines.includes('● $ rm -rf dist · allowed once'), lines.join('\n'));
    assert.ok(lines.includes('✗ Delete package-lock.json · rejected'));
    assert.ok(!lines.some((line) => line.includes('wants to')), 'the prompt collapsed');
  });

  it('maps keys to permission answers: digits, y, n, esc, and arrows with enter', async () => {
    const cases: Array<[string, string | null]> = [['2', 'always'], ['y', 'once'], ['n', 'no'], ['\u001b', 'no'], ['\u001b[C\u001b[C\r', 'no'], ['\t\r', 'always']];
    for (const [keys, optionId] of cases) {
      const { view, actions } = await setup(80, 24, 'q');
      view.apply(event({ type: 'turn.started', text: 'q', at: Date.now() }));
      view.apply(permissionRequest);
      assert.equal(view.handleInput(keys), true);
      assert.deepEqual(actions, [{ type: 'answer', requestId: 'p1', optionId }], `keys ${JSON.stringify(keys)}`);
      view.destroy();
    }
  });

  it('answers null when rejecting a prompt that offers no reject option', async () => {
    const { view, actions } = await setup(80, 24, 'q');
    view.apply(event({ ...permissionRequest, options: [{ optionId: 'once', name: 'Allow', kind: 'allow_once' }] }));
    view.handleInput('n');
    assert.deepEqual(actions, [{ type: 'answer', requestId: 'p1', optionId: null }]);
  });

  it('stops on ctrl-c, showing Stopping… until the turn ends', async () => {
    const { term, view, actions } = await setup(80, 12, 'q');
    view.apply(event({ type: 'turn.started', text: 'q', at: Date.now() }));
    view.apply(event({ type: 'message.chunk', messageId: 'm', kind: 'text', text: 'Partial answer' }));
    assert.equal(view.handleInput('\u0003'), true);
    assert.deepEqual(actions, [{ type: 'cancel' }]);
    await waitFor(async () => (await term.screen()).some((line) => line.includes('Stopping…')), term);
    view.apply(event({ type: 'turn.ended', stopReason: 'cancelled', error: null, durationMs: 2000 }));
    await view.finish();
    const lines = await term.allLines();
    assert.deepEqual(lines.slice(1), ['Partial answer', '', '◼ Stopped · 2s']);
  });

  it('goes to the background on esc: one note, then the terminal is free', async () => {
    const { term, view, actions } = await setup(80, 12, 'q');
    view.apply(event({ type: 'turn.started', text: 'q', at: Date.now() }));
    view.apply(event({ type: 'tool.updated', tool: { id: 'a', title: 'ls', kind: 'execute', status: 'in_progress', locations: [], content: [] } }));
    await waitFor(async () => (await term.screen()).some((line) => line.includes('Running ls')), term);
    assert.equal(view.handleInput('\u001b'), true);
    assert.deepEqual(actions, [{ type: 'background' }]);
    view.apply(event({ type: 'message.chunk', messageId: 'm', kind: 'text', text: 'ignored' }));
    await view.finish();
    const lines = await term.allLines();
    assert.deepEqual(lines.slice(1), ['↳ claude is still working · :: to check back']);
    assert.deepEqual(await term.cursor(), { row: 3, col: 1 });
    assert.equal(view.handleInput('x'), false, 'keys go back to the shell');
  });

  it('leaves ordinary typing alone while a turn runs', async () => {
    const { view } = await setup(80, 12, 'q');
    assert.equal(view.handleInput('ls'), false);
  });

  it('paints first quickly and keeps frames cheap', async () => {
    const { view } = await play('long-answer', 100, 30);
    const stats = view.renderStats;
    assert.ok(stats.firstPaintMs >= 0 && stats.firstPaintMs < 200, `first paint took ${stats.firstPaintMs} ms`);
    assert.ok(stats.averageFrameMs < 8, `frames average ${stats.averageFrameMs} ms`);
  });
});

const waitFor = async (predicate: () => Promise<boolean>, term: EmulatedTerminal): Promise<void> => {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out; screen:\n${(await term.screen()).join('\n')}`);
};
