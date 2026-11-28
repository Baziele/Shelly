import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { ScenarioDriver } from '../tools/scenario.js';
import { writeScreenshot } from '../tools/screen.js';

const DEMO = fileURLToPath(new URL('../../scripts/ui-demo.ts', import.meta.url));
const TSX = import.meta.resolve('tsx');
/** Set to a directory to keep a screenshot of every run, for looking at by eye. */
const SCREENSHOTS = process.env.SHELLY_SCREENSHOTS;

interface DemoRun {
  /** Every row, scrollback included, trailing spaces and empty rows at the end trimmed. */
  readonly lines: string[];
  readonly raw: string;
}

interface DemoOptions {
  readonly cols?: number;
  readonly rows?: number;
  readonly speed?: number;
  readonly env?: Record<string, string>;
  /** Called while the demo runs, e.g. to resize the terminal. */
  readonly during?: (driver: ScenarioDriver) => Promise<void>;
}

/** Run the UI demo for one sequence in a pseudo-terminal attached to xterm.js, until it exits. */
const runDemo = async (name: string, { cols = 100, rows = 30, speed = 3, env = {}, during }: DemoOptions = {}): Promise<DemoRun> => {
  const driver = await ScenarioDriver.start({
    command: [process.execPath, '--experimental-ffi', '--no-warnings', '--import', TSX, DEMO, name, '--speed', String(speed)],
    cwd: process.cwd(),
    cols,
    rows,
    env: { SHELLY_DEMO_LINGER_MS: '0', ...env },
    waitForPrompt: false,
  });
  try {
    await during?.(driver);
    try {
      await driver.waitForExit({ timeoutMs: 30_000 });
    } catch {
      throw new Error(`demo ${name} did not finish. Screen:\n${await driver.screen()}`);
    }
    const lines = await driver.lines({ scrollback: true });
    while (lines.length > 0 && lines[lines.length - 1] === '') {
      lines.pop();
    }
    if (SCREENSHOTS) {
      mkdirSync(SCREENSHOTS, { recursive: true });
      const size = `${driver.terminal.cols}x${driver.terminal.rows}`;
      await writeScreenshot(driver.terminal, join(SCREENSHOTS, `e2e-${name}-${size}${env.NO_COLOR ? '-nocolor' : ''}`), { scrollback: true });
    }
    return { lines, raw: driver.raw() };
  } finally {
    await driver.close();
  }
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
    const order = ['✗ $ pnpm test', '● Edit src/pages/Profile.tsx  +3', '● $ pnpm test --filter profile', '✓ 21s · 6 tools'].map((line) => lines.indexOf(line));
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
      during: async (driver) => {
        await driver.waitForText(/^3\. Timeouts/m, { timeoutMs: 15_000 });
        await driver.resize(140, 30);
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
