import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { lastPromptRow } from '../tools/scenario.js';
import { type Stack, startStack } from './stack.js';

/*
 * The whole stack: the first :: right after Shelly starts, while the daemon
 * is still starting. Esc (send to the background) before the thread is
 * ready gives the prompt back at once, not when the turn (7 s of work)
 * has run to its end.
 */

describe('cold start, Esc before the thread is ready', { timeout: 90_000 }, () => {
  let stack: Stack | undefined;
  afterEach(async () => {
    await stack?.stop();
    stack = undefined;
  });

  it('gives the prompt back soon after Esc', async () => {
    stack = await startStack({ shell: '/bin/zsh', cols: 100, rows: 30 });
    const driver = stack.driver;
    await driver.type('::');
    await driver.waitForText(':: Ask Shelly', { timeoutMs: 10_000 });
    await driver.type('marathon please');
    await driver.press('enter');
    // The view is up ("Starting agent…") while the daemon is still coming up.
    await driver.waitForText(/Starting/, { timeoutMs: 5000 });
    await driver.press('esc');
    const escAt = Date.now();
    await driver.waitForText(/still working/, { timeoutMs: 5000 });
    const note = (await driver.lines()).find((line) => /still working/.test(line));
    // The prompt looks back. Is the shell really listening? Probe every 500 ms with a key Shelly never eats.
    let back: number | undefined;
    for (let waited = 0; waited < 20_000; waited += 500) {
      await driver.type('x');
      await sleep(400);
      const lines = await driver.lines();
      const row = lastPromptRow(lines);
      if (row >= 0 && /^\$ x+$/.test(lines[row]!.trimEnd())) {
        back = Date.now() - escAt;
        break;
      }
    }
    assert.ok(note, 'the view said the agent is still working');
    assert.ok(back !== undefined && back < 2000, `the shell answered ${back ?? 'never'} ms after Esc`);
  });
});
