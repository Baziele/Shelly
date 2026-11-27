import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import xterm from '@xterm/headless';
import * as pty from 'node-pty';
import { saveScreenshot } from '../support/screenshot.js';

const DEMO = fileURLToPath(new URL('../../scripts/ui-demo.ts', import.meta.url));
const TSX = import.meta.resolve('tsx');
/** Set to a directory to keep a PNG of every run, for looking at by eye. */
const SCREENSHOTS = process.env.SHELLY_SCREENSHOTS;

interface DemoRun {
  readonly terminal: xterm.Terminal;
  /** Every row, scrollback included, trailing spaces and empty rows at the end trimmed. */
  readonly lines: string[];
  readonly screen: string[];
  readonly cursor: { row: number; col: number };
  readonly raw: string;
}

interface DemoOptions {
  readonly cols?: number;
  readonly rows?: number;
  readonly speed?: number;
  readonly env?: Record<string, string>;
  /** Called while the demo runs, e.g. to resize the terminal. */
  readonly during?: (control: { resize(cols: number, rows: number): void; screen(): Promise<string[]> }) => Promise<void>;
}

/** Run the UI demo for one sequence in a pseudo-terminal attached to xterm.js, until it exits. */
const runDemo = async (name: string, { cols = 100, rows = 30, speed = 3, env = {}, during }: DemoOptions = {}): Promise<DemoRun> => {
  const terminal = new xterm.Terminal({ cols, rows, allowProposedApi: true, scrollback: 5000 });
  const child = pty.spawn(process.execPath, ['--experimental-ffi', '--no-warnings', '--import', TSX, DEMO, name, '--speed', String(speed)], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: process.cwd(),
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: process.env.HOME ?? '/tmp',
      TERM: 'xterm-256color',
      LANG: 'en_US.UTF-8',
      SHELLY_DEMO_LINGER_MS: '0',
      ...env,
    },
  });
  let raw = '';
  child.onData((data) => {
    raw += data;
    terminal.write(data);
  });
  terminal.onData((reply) => child.write(reply));
  const exited = new Promise<number>((resolve) => child.onExit(({ exitCode }) => resolve(exitCode)));
  const flush = (): Promise<void> => new Promise((resolve) => terminal.write('', resolve));
  const screen = async (): Promise<string[]> => {
    await flush();
    const buffer = terminal.buffer.active;
    return Array.from({ length: terminal.rows }, (_, row) => buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? '');
  };

  await during?.({
    resize: (newCols, newRows) => {
      terminal.resize(newCols, newRows);
      child.resize(newCols, newRows);
    },
    screen,
  });
  const code = await Promise.race([exited, sleep(30_000).then(() => -1)]);
  if (code === -1) {
    child.kill();
    throw new Error(`demo ${name} did not finish. Screen:\n${(await screen()).join('\n')}`);
  }
  await flush();
  const buffer = terminal.buffer.active;
  const lines = Array.from({ length: buffer.length }, (_, row) => buffer.getLine(row)?.translateToString(true) ?? '');
  while (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  if (SCREENSHOTS) {
    saveScreenshot(terminal, `${SCREENSHOTS}/e2e-${name}-${terminal.cols}x${terminal.rows}${env.NO_COLOR ? '-nocolor' : ''}.png`, { region: 'all', title: `${name} ${terminal.cols}x${terminal.rows}` });
  }
  return { terminal, lines, screen: await screen(), cursor: { row: buffer.cursorY + 1, col: buffer.cursorX + 1 }, raw };
};

/** The demo's closing note, which the shell prompt would replace. */
const contentLines = (run: DemoRun): string[] => run.lines.filter((line) => !line.startsWith('(demo over'));

const assertClean = (run: DemoRun): void => {
  for (const line of run.lines) {
    assert.ok(!/\[[0-9;?]*[A-Za-z]|\u001b|[\u0000-\u0008]/.test(line), `stray escape: ${JSON.stringify(line)}`);
    assert.ok(!/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(line), `spinner left behind: ${line}`);
    assert.ok(!line.includes('esc background'), `status line left behind: ${line}`);
  }
};

describe('UI demo in a real terminal', { timeout: 120_000 }, () => {
  it('plays a tool-heavy turn: rows in order, summary last', async () => {
    const run = await runDemo('tool-heavy');
    assertClean(run);
    const lines = contentLines(run);
    assert.equal(lines[0], '~/acme-web $ :: run the tests and fix what fails');
    const order = ['✗ $ pnpm test', '● Edit src/pages/Profile.tsx  +3 −0', '● $ pnpm test --filter profile', '✓ 21s · 6 tools'].map((line) => lines.indexOf(line));
    assert.ok(order.every((index) => index > 0), lines.join('\n'));
    assert.deepEqual(order, [...order].sort((a, b) => a - b));
    assert.equal(lines.at(-1), '✓ 21s · 6 tools');
  });

  it('streams a long answer past the bottom of a narrow screen into complete scrollback', async () => {
    const run = await runDemo('long-answer', { cols: 44, rows: 20, speed: 4 });
    assertClean(run);
    const lines = contentLines(run);
    const headings = lines.filter((line) => /^\d\. [A-Z]/.test(line));
    assert.deepEqual(headings, ['1. Caching', '2. Retries', '3. Timeouts', '4. Logging', '5. Metrics', '6. Tracing', '7. Rate limits', '8. Feature flags']);
    assert.ok(lines.length > 100, 'the answer scrolled into scrollback');
    assert.ok(lines.every((line) => line.length <= 44));
    assert.match(lines.at(-1)!, /^✓ \d+s$/);
  });

  it('keeps scrollback whole when the terminal is resized mid-stream', async () => {
    const run = await runDemo('long-answer', {
      cols: 100,
      rows: 30,
      speed: 3,
      during: async ({ resize, screen }) => {
        for (let attempt = 0; attempt < 100 && !(await screen()).some((line) => line.startsWith('3. Timeouts')); attempt++) {
          await sleep(50);
        }
        resize(140, 30);
      },
    });
    assertClean(run);
    const lines = contentLines(run);
    for (const heading of ['1. Caching', '4. Logging', '8. Feature flags']) {
      assert.equal(lines.filter((line) => line === heading).length, 1, `${heading} appears once`);
    }
    assert.equal(lines.filter((line) => line.startsWith('That is the whole layer')).length, 1);
  });

  it('answers permission prompts from the keyboard', async () => {
    const run = await runDemo('permission-flow', { cols: 80, rows: 24 });
    assertClean(run);
    const lines = contentLines(run);
    assert.ok(lines.includes('● $ rm -rf dist · allowed once'), lines.join('\n'));
    assert.ok(lines.includes('✗ Delete package-lock.json · rejected'));
    assert.ok(!lines.some((line) => line.includes('wants to')));
  });

  it('shows how a failed and a stopped turn ended', async () => {
    const failed = contentLines(await runDemo('error-turn', { cols: 80, rows: 24 }));
    assert.equal(failed.at(-1), '✗ claude-agent-acp exited unexpectedly (code 1): API connection lost');
    const stopped = contentLines(await runDemo('cancelled-turn', { cols: 80, rows: 24 }));
    assert.match(stopped.at(-1)!, /^◼ Stopped · \d+s$/);
    assert.ok(stopped.includes('◼ Write README.md'), 'the tool that never ran shows as stopped');
  });

  it('prints a past exchange as history', async () => {
    const run = await runDemo('history', { cols: 80, rows: 30 });
    const lines = contentLines(run);
    assert.match(lines[1]!, /^── “why does the dev server start on 3001” · claude · 2h ago ─+$/);
    assert.match(lines.at(-3)!, /^… \(\d+ more lines\)$/);
  });

  it('puts a fast-mode command on the input line, leaving no trace of the input', async () => {
    const run = await runDemo('fast-command', { cols: 80, rows: 12 });
    const lines = contentLines(run);
    assert.deepEqual(lines, ['~/acme-web $ find . -type f -size +100M -exec ls -lh {} +']);
  });

  it('prints a fast-mode answer below the echoed request', async () => {
    const lines = contentLines(await runDemo('fast-answer', { cols: 80, rows: 12 }));
    assert.equal(lines[0], '~/acme-web $ __ what does lsof -i :3000 show');
    assert.match(lines[1]!, /^It lists the processes with a network socket on port 3000/);
  });

  it('renders without colour under NO_COLOR', async () => {
    const run = await runDemo('markdown-showcase', { cols: 80, rows: 24, speed: 4, env: { NO_COLOR: '1' } });
    assertClean(run);
    assert.ok(!/\u001b\[[0-9;]*(?:3[0-7]|38;[25]|9[0-7])m/.test(run.raw.replace(/\u001b\[1;3[0-9]m/g, '')), 'a colour was written');
    assert.ok(contentLines(run).includes('Why the build failed'));
  });
});
