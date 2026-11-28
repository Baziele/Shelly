import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { LONG_ANSWER } from '../fixtures/fake-agent/scenarios/long-answer.js';
import { lastPromptRow } from '../tools/scenario.js';
import { type Stack, startStack } from './stack.js';

/*
 * Resizing the terminal while an answer streams, through the whole stack:
 * Shelly, its shell, the daemon and the fake agent. Rows committed to
 * scrollback are never rewritten or erased, so every paragraph must end up
 * there exactly once, whole, whatever the sizes and the pacing.
 */

/** The terminal's rows joined back into logical lines (rows it wrapped itself belong together). */
const logicalLines = (stack: Stack): string[] => {
  const buffer = stack.driver.terminal.buffer.active;
  const lines: string[] = [];
  for (let row = 0; row < buffer.length; row++) {
    const line = buffer.getLine(row);
    const text = line?.translateToString(true) ?? '';
    if (line?.isWrapped && lines.length > 0) {
      lines[lines.length - 1] += text;
    } else {
      lines.push(text);
    }
  }
  return lines;
};

/** Text as words: markdown markers dropped, any run of spaces or row breaks one space (a hyphen may end a row). */
const words = (text: string): string => text.replace(/\*\*/g, '').replace(/\s+/g, ' ').replace(/- /g, '-').trim();

/** Block this process's event loop, as a busy terminal would: its replies to Shelly come late. */
const stall = (ms: number): void => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // Busy.
  }
};

let stack: Stack | undefined;
afterEach(async () => {
  await stack?.stop();
  stack = undefined;
});

describe('resizing during an answer', { timeout: 120_000 }, () => {
  for (const pace of ['slowly', 'quickly'] as const) {
    it(`keeps every paragraph exactly once and whole, narrowing then widening, ${pace} paced`, async () => {
      stack = await startStack({ cols: 120, rows: 30 });
      const { driver } = stack;
      await driver.type('::');
      await driver.waitForText(':: Ask Shelly', { timeoutMs: 10_000 });
      await driver.type(`paced ${pace}`);
      await driver.press('enter');
      await driver.waitForText('Part 1.', { timeoutMs: 20_000 });
      if (pace === 'slowly') {
        await sleep(600);
      }

      await driver.resize(60, 26);
      stall(900);
      await sleep(pace === 'slowly' ? 1200 : 200);
      await driver.resize(120, 30);
      stall(900);

      await driver.waitFor((lines) => lines[lastPromptRow(lines)]?.trimEnd() === '$' && lines.some((line) => /^✓ /.test(line)), 'the turn to end', { timeoutMs: 60_000 });
      const text = words(logicalLines(stack).join(' '));
      const paragraphs = LONG_ANSWER.split('\n').filter((line) => line.trim() !== '').map(words);
      for (const [index, paragraph] of paragraphs.entries()) {
        assert.equal(text.split(paragraph).length - 1, 1, `paragraph ${index + 1} is not there exactly once, whole:\n${logicalLines(stack).filter((line) => line.trim()).join('\n')}`);
        assert.equal(text.split(`Part ${index + 1}.`).length - 1, 1, `a piece of paragraph ${index + 1} is repeated:\n${logicalLines(stack).filter((line) => line.trim()).join('\n')}`);
      }
    });
  }
});
