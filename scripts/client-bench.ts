/*
 * Measures what the user feels, in a real pty, against the fake agent:
 *
 *   startup   spawn → first `$ ` prompt on screen
 *   open      `::` typed → the input visible
 *   feedback  Enter → the first row below the echoed request (agent mode)
 *   memory    the client's RSS after 5 and after 50 agent turns
 *
 *   node --import tsx scripts/client-bench.ts [--entry path/to/src/index.ts] [--runs 10] [--turns 50] [--only startup] [--shell path]
 *
 * --entry points at another checkout's src/index.ts, to compare a branch
 * with main. The checkout must have node_modules. Prints medians.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { lastPromptRow, type ScenarioDriver } from '../test/tools/scenario.js';
import { startStack } from '../test/e2e/stack.js';

const { values } = parseArgs({
  options: {
    entry: { type: 'string' },
    runs: { type: 'string', default: '10' },
    turns: { type: 'string', default: '50' },
    only: { type: 'string' },
    shell: { type: 'string' },
  },
});

const runs = Number(values.runs);
const turns = Number(values.turns);
/** zsh where there is one, else the user's shell, else bash. */
const shell = values.shell
  ?? ['/bin/zsh', '/usr/bin/zsh', process.env.SHELL, '/bin/bash', '/usr/bin/bash'].find((candidate) => candidate && existsSync(candidate))
  ?? '/bin/sh';
const command = values.entry
  ? [process.execPath, '--experimental-ffi', '--no-warnings', '--import', import.meta.resolve('tsx'), resolve(values.entry)]
  : undefined;

const median = (samples: number[]): number => {
  const sorted = [...samples].sort((a, b) => a - b);
  return Math.round(sorted[Math.floor(sorted.length / 2)]!);
};
const atPrompt = (lines: string[]): boolean => /^\$\s*$/.test(lines[lastPromptRow(lines)] ?? '');
const wants = (name: string): boolean => !values.only || values.only.split(',').includes(name);

const start = async (): Promise<{ driver: ScenarioDriver; stop: () => Promise<void>; startedAt: number; promptAt: number }> => {
  const startedAt = performance.now();
  const stack = await startStack({ shell, cols: 100, rows: 30, ...(command ? { command } : {}) });
  return { driver: stack.driver, stop: () => stack.stop(), startedAt, promptAt: performance.now() };
};

const results: Record<string, number | string> = {};

if (wants('startup') || wants('open') || wants('feedback')) {
  const startup: number[] = [];
  const open: number[] = [];
  const feedback: number[] = [];
  for (let run = 0; run < runs; run++) {
    const { driver, stop, startedAt, promptAt } = await start();
    try {
      startup.push(promptAt - startedAt);
      // Let the background work (UI load, daemon connection) settle, as a user's first seconds would.
      await new Promise((r) => setTimeout(r, 1500));
      let t = performance.now();
      await driver.type('::', { perCharDelayMs: 0 });
      await driver.waitForText(/:: Ask Shelly/, { timeoutMs: 10_000 });
      open.push(performance.now() - t);
      if (wants('feedback')) {
        await driver.type('show me markdown', { perCharDelayMs: 0 });
        await driver.waitForText(':: show me markdown');
        t = performance.now();
        await driver.press('enter');
        await driver.waitFor((lines) => {
          const echo = lines.findIndex((line) => line.startsWith('$ :: show me markdown'));
          return echo >= 0 && lines.slice(echo + 1).some((line) => line.trim() !== '');
        }, 'the first feedback', { timeoutMs: 10_000 });
        feedback.push(performance.now() - t);
        await driver.waitFor(atPrompt, 'the turn to end', { timeoutMs: 20_000 });
      }
    } finally {
      await stop();
    }
  }
  results['startup to first prompt (ms, median)'] = median(startup);
  results[':: to input visible (ms, median)'] = median(open);
  if (feedback.length) {
    results['Enter to first feedback (ms, median)'] = median(feedback);
  }
}

if (wants('memory')) {
  const { driver, stop } = await start();
  const rss = (): number => Number(execFileSync('ps', ['-o', 'rss=', '-p', String(driver.pid)], { encoding: 'utf8' }).trim()) / 1024;
  try {
    const samples: Record<number, number> = {};
    for (let turn = 1; turn <= turns; turn++) {
      await driver.type(`::turn ${turn}\r`, { perCharDelayMs: 0 });
      await driver.waitFor((lines) => lines.some((line) => line.startsWith(`$ :: turn ${turn}`)) && atPrompt(lines), `turn ${turn}`, { timeoutMs: 20_000, scrollback: true });
      if (turn === 5 || turn % 25 === 0 || turn === turns) {
        await new Promise((r) => setTimeout(r, 500));
        samples[turn] = rss();
      }
    }
    for (const [turn, mb] of Object.entries(samples)) {
      results[`client RSS after ${turn} turns (MB)`] = mb.toFixed(1);
    }
  } finally {
    await stop();
  }
}

console.log(JSON.stringify(results, null, 2));
