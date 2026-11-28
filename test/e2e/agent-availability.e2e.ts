import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { lastPromptRow, NO_AGENTS_CONFIG, ScenarioDriver } from '../tools/scenario.js';
import { E2E_SHELLS } from './stack.js';

/*
 * `::` with no agent Shelly can use: it never fails silently. The hint says
 * so before Enter, the reason is printed inline with ✗, the daemon logs the
 * refusal (never the prompt), and /agent lists every agent with the reason
 * and where to add one.
 */

const PATH = '/usr/bin:/bin';
const SECRET = 'zebra-umbrella';

const atPrompt = (lines: string[]): boolean => lines[lastPromptRow(lines)]?.trimEnd() === '$';

const daemonLog = (driver: ScenarioDriver): string => readFileSync(join(driver.shellyHome, 'logs', 'daemon.log'), 'utf8');

for (const shell of E2E_SHELLS) {
  describe(`no usable agent in ${basename(shell)}`, { timeout: 90_000 }, () => {
    let driver: ScenarioDriver | undefined;

    afterEach(async () => {
      await driver?.close();
      driver = undefined;
    });

    it('says OpenCode is not installed in the hint and inline, and logs the refusal without the prompt', async () => {
      driver = await ScenarioDriver.start({ shell, cols: 100, rows: 20, env: { PATH }, config: { agents: { claude: { enabled: false } } } });
      await driver.type('::');
      await driver.waitForText(/OpenCode · not installed\s*$/m, { timeoutMs: 15_000 });
      await driver.type(`hello ${SECRET}\r`);
      await driver.waitForText(/^✗ OpenCode isn't installed\. Install it from opencode\.ai, then try again\.$/m, { timeoutMs: 15_000 });
      await driver.waitFor(atPrompt, 'the prompt back');
      const lines = await driver.lines();
      assert.ok(!lines.some((line) => /Try again, or check|<1s|✓/.test(line)), lines.join('\n'));

      // The second time, with the agents known, reads the same.
      await driver.type(`::again ${SECRET}\r`);
      await driver.waitFor(
        (rows) => rows.filter((row) => row.startsWith("✗ OpenCode isn't installed.")).length === 2 && atPrompt(rows),
        'the same message again',
        { timeoutMs: 15_000 },
      );
      assert.ok(!(await driver.lines()).some((line) => /Try again, or check|<1s/.test(line)));

      const log = daemonLog(driver);
      assert.match(log, /thread refused agent=opencode: OpenCode isn't installed/);
      assert.ok(!log.includes(SECRET), 'the log never holds the prompt');
    });

    it('with no agent at all, points at the config file and /agent, which lists every agent', async () => {
      driver = await ScenarioDriver.start({ shell, cols: 110, rows: 20, env: { PATH }, config: NO_AGENTS_CONFIG });
      const config = join(driver.shellyHome, 'config.json');
      await driver.type('::');
      await driver.waitForText(/no agent set up · \/agent\s*$/m, { timeoutMs: 15_000 });
      await driver.type('hello\r');
      await driver.waitFor(atPrompt, 'the prompt back', { timeoutMs: 15_000 });
      const said = (await driver.lines()).join(' ').replace(/\s+/g, ' ');
      assert.ok(said.includes(`✗ No agent is set up. Install Claude Code or OpenCode, or add an agent to ${config} · /agent shows what Shelly found.`), said);

      await driver.type('::/agent\r');
      await driver.waitForText('No agent can be used yet', { timeoutMs: 10_000 });
      const lines = await driver.lines();
      assert.ok(lines.some((line) => /Claude Code\s+turned off in/.test(line)), lines.join('\n'));
      assert.ok(lines.some((line) => /OpenCode\s+turned off in/.test(line)), lines.join('\n'));
      assert.ok(lines.some((line) => line.includes('Install Claude Code or OpenCode, or add an agent to "agents" in')), lines.join('\n'));
      await driver.press('esc');
      await driver.waitFor((rows) => !rows.some((row) => row.includes('No agent can be used yet')), 'the picker closed');
      await driver.press('esc');
      await driver.waitFor(atPrompt, 'the prompt back');
    });
  });
}
