import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { shellyPaths } from '../../src/protocol/paths.js';
import { probeSocket } from '../../src/protocol/probe.js';
import { lastPromptRow, type ScenarioDriver } from '../tools/scenario.js';
import { E2E_SHELLS, type Stack, startStack } from './stack.js';

/*
 * Fast mode end to end, through the daemon's real fast-mode service and
 * the fake `claude` (test/fixtures/fake-claude.mjs), which replies to
 * `reply: <text>` with that text, fails on `auth`, and otherwise writes a
 * command, `echo pid=<pid> turn=<n>`.
 */

const REPLY_MS = 20_000;

/** bash before 4 (macOS's 3.2) cannot hand its line over. */
const canCapture = (shell: string): boolean =>
  basename(shell) !== 'bash'
  || Number(execFileSync(shell, ['-c', 'echo "${BASH_VERSINFO[0]}"'], { encoding: 'utf8' }).trim()) >= 4;

const promptRow = (lines: string[]): string => lines[lastPromptRow(lines)]?.trimEnd() ?? '';

const openFast = async (driver: ScenarioDriver): Promise<void> => {
  await driver.type('__');
  await driver.waitForText('__ Describe a command', { timeoutMs: 10_000 });
};

for (const shell of E2E_SHELLS) {
  describe(`fast mode in ${basename(shell)}`, { timeout: 120_000 }, () => {
    let stack: Stack | undefined;

    afterEach(async () => {
      await stack?.stop();
      stack = undefined;
    });

    it('puts a command on the line, unexecuted, and continues the conversation until it runs', async () => {
      stack = await startStack({ shell, cols: 100, rows: 24 });
      const driver = stack.driver;
      await openFast(driver);
      await driver.type('list the files\r');
      let lines = await driver.waitFor((rows) => /^\$ echo pid=\d+ turn=1$/.test(promptRow(rows)), 'the command on the line', { timeoutMs: REPLY_MS });
      assert.ok(!lines.some((row) => row.includes('__') || row.includes('list the files')), `the input left no trace:\n${lines.join('\n')}`);
      assert.ok(!lines.some((row) => row.startsWith('pid=')), 'nothing ran');
      const pid = /pid=(\d+)/.exec(promptRow(lines))![1];

      if (canCapture(shell)) {
        // A follow-up on the command it wrote continues the same conversation.
        await driver.type('\u001d');
        await driver.waitForText(`rewriting: echo pid=${pid} turn=1`);
        await driver.type('make it louder\r');
        lines = await driver.waitFor((rows) => promptRow(rows) === `$ echo pid=${pid} turn=2`, 'the follow-up command', { timeoutMs: REPLY_MS });
      }

      // The cursor is at the end, so typing appends; Enter runs it.
      await driver.type(' extra\r');
      await driver.waitFor((rows) => rows.some((row) => /^pid=\d+ turn=\d extra$/.test(row)), 'the command to run');

      // Once a command it wrote has run, the next request starts afresh.
      await openFast(driver);
      await driver.type('something else\r');
      await driver.waitFor((rows) => /^\$ echo pid=\d+ turn=1$/.test(promptRow(rows)), 'a new conversation', { timeoutMs: REPLY_MS });
    });

    it('never sends a request stopped while it was getting ready, and the next one works', async () => {
      const log = join(tmpdir(), `shelly-fake-claude-${process.pid}-${Date.now()}.ndjson`);
      try {
        // The daemon waits 4 s before it answers (a test hook), so the first request waits for it to connect.
        stack = await startStack({
          shell,
          cols: 100,
          rows: 24,
          fakeClaudeEnv: { FAKE_CLAUDE_LOG: log },
          env: { SHELLY_DAEMON_TEST_LOCK_AT: String(Date.now() + 4000) },
        });
        const driver = stack.driver;
        await openFast(driver);
        await driver.type('reply: never sent\r');
        await driver.waitFor((rows) => rows.some((row) => /__ reply: never sent [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(row)), 'the request getting ready');
        await driver.press('esc');
        await driver.waitFor((rows) => promptRow(rows) === '$' && !rows.some((row) => row.includes('never sent')), 'the input closed');
        // Let the daemon come up, and anything still pending reach it, before asking again.
        const socket = shellyPaths({ SHELLY_HOME: stack.shellyHome }).socket;
        for (let waited = 0; waited < 15_000 && !(await probeSocket(socket)); waited += 100) {
          await sleep(100);
        }
        await sleep(1500);

        await openFast(driver);
        await driver.type('reply: # The second one.\r');
        await driver.waitFor((rows) => rows.some((row) => row === 'The second one.') && promptRow(rows) === '$', 'the next request', { timeoutMs: REPLY_MS });
        const requests = existsSync(log)
          ? readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { event: string; request?: string }).filter((entry) => entry.event === 'request')
          : [];
        assert.deepEqual(requests.map((entry) => entry.request), ['reply: # The second one.'], 'only the second request reached claude');
      } finally {
        rmSync(log, { force: true });
      }
    });

    it('prints an answer below the request, then the prompt', async () => {
      stack = await startStack({ shell, cols: 100, rows: 24 });
      const driver = stack.driver;
      await openFast(driver);
      await driver.type('reply: # Use `ls -la` to see hidden files.\r');
      const lines = await driver.waitFor(
        (rows) => rows.some((row) => row.includes('to see hidden files')) && promptRow(rows) === '$',
        'the answer and the prompt',
        { timeoutMs: REPLY_MS },
      );
      const echo = lines.findIndex((row) => row.startsWith('$ __ reply:'));
      assert.ok(echo >= 0, `the request is echoed:\n${lines.join('\n')}`);
      assert.match(lines[echo + 1] ?? '', /^Use ls -la to see hidden files\.$/);
      assert.equal(lastPromptRow(lines), echo + 2, 'the prompt right below the answer');
    });

    it('keeps the input open with the error, and gives the line back on Esc', async () => {
      stack = await startStack({ shell, cols: 100, rows: 24 });
      const driver = stack.driver;
      await openFast(driver);
      await driver.type('auth\r');
      await driver.waitFor(
        (rows) => promptRow(rows).startsWith('$ __ auth') && rows.some((row) => row.includes('✗')),
        'the error under the input',
        { timeoutMs: REPLY_MS },
      );
      // Still editable: fix the request and retry.
      await driver.press('backspace', 4);
      await driver.type('reply: # Fine now.\r');
      await driver.waitFor((rows) => rows.some((row) => row === 'Fine now.') && promptRow(rows) === '$', 'the retry', { timeoutMs: REPLY_MS });

      await openFast(driver);
      await driver.type('hang\r');
      await driver.waitFor((rows) => rows.some((row) => /__ hang [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(row)), 'the request running');
      await driver.press('esc');
      await driver.waitFor((rows) => promptRow(rows) === '$' && !rows.some((row) => row.includes('__ hang')), 'the input closed, nothing left');
      await driver.type('echo after\r');
      await driver.waitForText(/^after$/m);
    });

    it('rewrites the line it took with Ctrl+], and puts it back on Esc', { skip: !canCapture(shell) && 'this bash cannot hand its line over (see rewrite-hotkey.e2e.ts)' }, async () => {
      stack = await startStack({ shell, cols: 100, rows: 24 });
      const driver = stack.driver;
      await driver.type('git psuh origin');
      await driver.waitFor((rows) => promptRow(rows) === '$ git psuh origin', 'the typed line');
      await driver.type('\u001d');
      await driver.waitForText('rewriting: git psuh origin');
      await driver.press('esc');
      await driver.waitFor((rows) => promptRow(rows) === '$ git psuh origin', 'the line back');

      await driver.type('\u001d');
      await driver.waitForText('rewriting: git psuh origin');
      await driver.type('fix the typo\r');
      const lines = await driver.waitFor((rows) => /^\$ echo pid=\d+ turn=1$/.test(promptRow(rows)), 'the rewritten line', { timeoutMs: REPLY_MS });
      assert.ok(!lines.some((row) => row.includes('rewriting')), 'no trace of the input');
    });
  });
}
