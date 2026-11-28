import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { ScenarioDriver } from '../tools/scenario.js';
import { fakeAgentConfig } from './stack.js';

/*
 * The hint on the right of `::` (where the message goes) is there the
 * moment the input opens, even with the daemon cold: a terminal shows what
 * the daemon last said, kept in $SHELLY_HOME, then puts it right in place.
 */

describe('the hint with a cold daemon', { timeout: 60_000 }, () => {
  // Short: the daemon's socket path under it must fit in 104 bytes.
  const shellyHome = mkdtempSync(join(tmpdir(), 'sh-'));
  writeFileSync(join(shellyHome, 'config.json'), JSON.stringify(fakeAgentConfig()));
  after(() => rmSync(shellyHome, { recursive: true, force: true }));

  const firstFrame = async (driver: ScenarioDriver): Promise<string> => {
    await driver.type('::');
    // Polled every few milliseconds: the first screen with the input on it.
    const lines = await driver.waitFor((rows) => rows.some((row) => row.includes(':: Ask')), 'the input', { timeoutMs: 15_000 });
    return lines.find((row) => row.includes(':: Ask')) ?? '';
  };

  it('shows the last-known agent at once in the next terminal', async () => {
    const first = await ScenarioDriver.start({ cols: 100, rows: 12, env: { SHELLY_HOME: shellyHome } });
    try {
      await firstFrame(first);
      await first.waitForText(/Fake Agent · new thread\s*$/m, { timeoutMs: 15_000 });
      await first.press('esc');
    } finally {
      // Stops the daemon too: the next terminal finds it cold.
      await first.close();
    }
    assert.ok(existsSync(join(shellyHome, 'agents-cache.json')));

    const second = await ScenarioDriver.start({ cols: 100, rows: 12, env: { SHELLY_HOME: shellyHome } });
    try {
      const row = await firstFrame(second);
      assert.match(row, /Fake Agent · new thread\s*$/, 'in the first frame');
      await second.press('esc');
    } finally {
      await second.close();
    }
  });
});
