import assert from 'node:assert/strict';
import { basename } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { flush, readGrid } from '../tools/screen.js';
import { lastPromptRow, type ScenarioDriver } from '../tools/scenario.js';
import { E2E_SHELLS, type Stack, startStack } from './stack.js';

/*
 * A turn sent to the background says when it finishes, in every shell: muted
 * below an empty prompt (gone as soon as `::` opens, whose hint says the same),
 * or, when a command is running, just above the next prompt.
 */

const TURN_MS = 20_000;
const NOTICE = 'Fake Agent finished · :: then enter to see';

const atPrompt = (lines: string[]): boolean => lines[lastPromptRow(lines)]?.trimEnd() === '$';

const background = async (driver: ScenarioDriver, request: string): Promise<void> => {
  await driver.type(`::${request}\r`);
  await driver.waitForText('Running make', { timeoutMs: TURN_MS });
  await driver.press('esc');
  await driver.waitFor((rows) => rows.some((row) => row.includes('still working')) && atPrompt(rows), 'the prompt back');
};

/** Whether every cell of `text` on screen is drawn dim (muted). */
const isMuted = async (driver: ScenarioDriver, text: string): Promise<boolean> => {
  await flush(driver.terminal);
  const lines = await driver.lines();
  const row = lines.findIndex((line) => line.startsWith(text));
  const grid = readGrid(driver.terminal);
  return row >= 0 && (grid.rows[row] ?? []).slice(0, text.length).every((cell) => cell.dim || cell.chars === ' ');
};

for (const shell of E2E_SHELLS) {
  describe(`the background turn's notice in ${basename(shell)}`, { timeout: 90_000 }, () => {
    let stack: Stack | undefined;

    afterEach(async () => {
      await stack?.stop();
      stack = undefined;
    });

    it('shows below an empty prompt, muted, and goes when the input opens', async () => {
      stack = await startStack({ shell, cols: 100, rows: 16 });
      const driver = stack.driver;
      await background(driver, 'slow build');
      const lines = await driver.waitFor((rows) => rows.some((row) => row === NOTICE), 'the notice', { timeoutMs: TURN_MS });
      assert.equal(lines.indexOf(NOTICE), lastPromptRow(lines) + 1, `right below the prompt:\n${lines.join('\n')}`);
      assert.ok(await isMuted(driver, NOTICE), 'drawn muted');

      await driver.type('::');
      const open = await driver.waitFor((rows) => /✓ Fake Agent finished · enter to see\s*$/.test(rows[lastPromptRow(rows)] ?? ''), 'the hint');
      assert.ok(!open.includes(NOTICE), `the notice is gone under the input:\n${open.join('\n')}`);
      await driver.press('esc');
      await driver.waitFor(atPrompt, 'the prompt back');
    });

    it('waits for the next prompt when a command is running', async () => {
      stack = await startStack({ shell, cols: 100, rows: 16 });
      const driver = stack.driver;
      await background(driver, 'slow build');
      await driver.type('sleep 4; echo slept\r');
      const lines = await driver.waitFor(
        (rows) => rows.includes('slept') && atPrompt(rows),
        'the command done',
        { timeoutMs: TURN_MS },
      );
      const prompt = lastPromptRow(lines);
      assert.deepEqual(lines.slice(prompt - 2, prompt + 1).map((line) => line.trimEnd()), ['slept', NOTICE, '$'], lines.join('\n'));
      assert.ok(await isMuted(driver, NOTICE), 'printed muted');
    });
  });
}
