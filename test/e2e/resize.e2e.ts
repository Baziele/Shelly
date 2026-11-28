import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { LONG_ANSWER } from '../fixtures/fake-agent/scenarios/long-answer.js';
import { lastPromptRow } from '../tools/scenario.js';
import { type Stack, startStack } from './stack.js';

/*
 * Resizing the terminal while an answer streams, through the whole stack:
 * Shelly, its shell, the daemon and the fake agent. Whatever the sizes, the
 * pacing and the terminal's speed:
 * - nothing is lost: the whole answer is there, in order;
 * - lines committed before a resize stay exactly as they were;
 * - at most the rows that were live at a resize show twice (the top of a
 *   live row the terminal rewrapped): a few rows, since the live region
 *   holds only the line being written and the status line.
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

/** The words of `text` the longest common subsequence with `expected` leaves out of `text`, and whether all of `expected` was found. */
const unmatched = (expected: readonly string[], text: readonly string[]): { readonly missing: number; readonly extra: string[] } => {
  const rows = expected.length + 1;
  const cols = text.length + 1;
  const table = new Uint16Array(rows * cols);
  for (let i = expected.length - 1; i >= 0; i--) {
    for (let j = text.length - 1; j >= 0; j--) {
      table[i * cols + j] = expected[i] === text[j]
        ? table[(i + 1) * cols + j + 1]! + 1
        : Math.max(table[(i + 1) * cols + j]!, table[i * cols + j + 1]!);
    }
  }
  const extra: string[] = [];
  let i = 0;
  let j = 0;
  while (i < expected.length && j < text.length) {
    if (expected[i] === text[j]) {
      i++;
      j++;
    } else if (table[(i + 1) * cols + j]! >= table[i * cols + j + 1]!) {
      i++;
    } else {
      extra.push(text[j++]!);
    }
  }
  extra.push(...text.slice(j));
  return { missing: expected.length - table[0]!, extra };
};

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

/** The answer's lines: after the echoed request, up to the footer. */
const answerLines = (lines: readonly string[]): string[] => {
  const start = lines.findIndex((line) => line.startsWith('$ :: paced'));
  const end = lines.findLastIndex((line) => /^✓ /.test(line));
  return lines.slice(start + 1, end < 0 ? undefined : end).filter((line) => line.trim() !== '');
};

describe('resizing during an answer', { timeout: 120_000 }, () => {
  // Slow replies: the terminal takes 700 ms to answer anything, as over a slow link. Shelly asks it
  // nothing while streaming, so that must change nothing.
  for (const [pace, replyDelayMs] of [['slowly', 0], ['quickly', 0], ['quickly', 700]] as const) {
    it(`loses nothing, keeps committed lines, shows at most the live rows twice: narrowing then widening, ${pace} paced${replyDelayMs ? `, replies taking ${replyDelayMs} ms` : ''}`, async () => {
      stack = await startStack({ cols: 120, rows: 30 });
      const { driver } = stack;
      await driver.type('::');
      await driver.waitForText(':: Ask Shelly', { timeoutMs: 10_000 });
      await driver.type(`paced ${pace}`);
      await driver.press('enter');
      await driver.waitForText('Part 1.', { timeoutMs: 20_000 });
      driver.replyDelayMs = replyDelayMs;
      if (pace === 'slowly') {
        await sleep(600);
      }

      // What is committed before the first resize: all but the last few rows (the live region).
      const LIVE_ROWS_AT_MOST = 4;
      const committedBefore = answerLines(logicalLines(stack)).slice(0, -LIVE_ROWS_AT_MOST);
      await driver.resize(60, 26);
      stall(900);
      await sleep(pace === 'slowly' ? 1200 : 200);
      await driver.resize(120, 30);
      stall(900);

      await driver.waitFor((lines) => lines[lastPromptRow(lines)]?.trimEnd() === '$' && lines.some((line) => /^✓ /.test(line)), 'the turn to end', { timeoutMs: 60_000 });
      const lines = answerLines(logicalLines(stack));
      const shown = `\n${lines.join('\n')}`;

      // Committed lines stay exactly as they were, in order.
      let from = 0;
      for (const line of committedBefore) {
        const at = lines.indexOf(line, from);
        assert.ok(at >= 0, `a committed line changed or went: ${JSON.stringify(line)}${shown}`);
        from = at + 1;
      }
      // Nothing is lost: the whole answer, in order.
      const expected = words(LONG_ANSWER).split(' ');
      const { missing, extra } = unmatched(expected, words(lines.join(' ')).split(' '));
      assert.equal(missing, 0, `words of the answer lost${shown}`);
      // At most the rows live at each resize show twice: two resizes, a couple of live rows above the
      // cursor each, at most 120 columns a row.
      const extraChars = extra.join(' ').length;
      assert.ok(extraChars <= 2 * 2 * 120, `${extraChars} characters show twice: ${JSON.stringify(extra.join(' '))}${shown}`);
      assert.ok(!lines.some((line) => /esc background|\^c stop/.test(line)), `the status line left behind${shown}`);
    });
  }
});
