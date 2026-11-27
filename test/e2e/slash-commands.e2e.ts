import assert from 'node:assert/strict';
import { basename } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { lastPromptRow, type ScenarioDriver } from '../tools/scenario.js';
import { E2E_SHELLS, type Stack, startStack } from './stack.js';

/*
 * The `::` input's slash commands end to end, against the real daemon and
 * the fake ACP agent: threads (new, here, switching with history, renaming,
 * the agent's own title), the agent, the mode, and what Shelly shows.
 */

const TURN_MS = 20_000;

const atPrompt = (lines: string[]): boolean => lines[lastPromptRow(lines)]?.trimEnd() === '$';

const open = async (driver: ScenarioDriver, hint?: RegExp): Promise<void> => {
  await driver.type('::');
  await driver.waitForText(hint ?? ':: Ask Shelly', { timeoutMs: 10_000 });
};

/** Esc closes the input; wait for the prompt (Esc and a key right after it would read as Alt+key). */
const close = async (driver: ScenarioDriver): Promise<void> => {
  await driver.press('esc');
  await driver.waitFor(atPrompt, 'the prompt back');
};

/** Ask something and wait for the turn to end with the prompt back. */
const ask = async (driver: ScenarioDriver, text: string): Promise<void> => {
  await open(driver);
  await driver.type(`${text}\r`);
  await driver.waitFor((lines) => {
    const echo = lines.findLastIndex((line) => line.startsWith(`$ :: ${text}`));
    const end = lines.findLastIndex((line) => /^✓ /.test(line));
    return echo >= 0 && end > echo && atPrompt(lines);
  }, `the answer to "${text}"`, { timeoutMs: TURN_MS, scrollback: true });
};

for (const shell of E2E_SHELLS) {
  describe(`slash commands in ${basename(shell)}`, { timeout: 150_000 }, () => {
    let stack: Stack | undefined;

    afterEach(async () => {
      await stack?.stop();
      stack = undefined;
    });

    it('names, renames, starts and switches threads, showing the last exchange', async () => {
      stack = await startStack({ shell, cols: 110, rows: 30 });
      const driver = stack.driver;

      // The agent names the thread itself.
      await ask(driver, 'please name yourself');
      await open(driver, /fake · “Agent picked title”/);

      // A rename sticks, even when the agent names it again.
      await driver.type('/rename Fixing the build\r');
      await driver.waitForText(/fake · “Fixing the build”/);
      await close(driver);
      await ask(driver, 'name yourself again');
      await open(driver, /fake · “Fixing the build”/);

      // /new: the next message starts another thread.
      await driver.type('/new\r');
      await driver.waitForText(/fake · new thread/);
      await close(driver);
      await ask(driver, 'show me markdown');
      await open(driver, /fake · “show me markdown”/);

      // /threads: both, most recent first; pick the first one back.
      await driver.type('/threads\r');
      await driver.waitForText('Pick a thread');
      let lines = await driver.lines();
      const listed = lines.filter((line) => /Fixing the build|show me markdown/.test(line));
      assert.equal(listed.length, 2, lines.join('\n'));
      assert.match(listed[0]!, /show me markdown/, 'most recent first');
      await driver.type('fixing');
      await driver.waitFor((rows) => !rows.some((row) => row.includes('show me markdown ')) || rows.filter((row) => /Fixing the build|show me markdown/.test(row)).length === 1, 'the filter');
      await driver.press('enter');
      lines = await driver.waitFor(
        (rows) => rows.some((row) => /── “Fixing the build” · fake ·/.test(row)) && atPrompt(rows),
        'the thread history',
        { timeoutMs: TURN_MS },
      );
      const header = lines.findIndex((row) => row.includes('“Fixing the build”'));
      assert.ok(lines.slice(header).some((row) => row.startsWith(':: name yourself again')), 'the last request');
      assert.ok(lines.slice(header).some((row) => row === 'Named.'), 'and its answer');
      assert.equal(lines[lastPromptRow(lines) - 1]?.startsWith('✓'), true, `the prompt right below:\n${lines.join('\n')}`);
      await open(driver, /fake · “Fixing the build”/);
      await close(driver);
    });

    it('switches mode and agent from pickers, roots a thread here, and shows context and help', async () => {
      stack = await startStack({ shell, cols: 110, rows: 30 });
      const driver = stack.driver;

      // /mode before any message: the thread starts so its modes can be listed.
      await open(driver, /fake · new thread/);
      await driver.type('/mode\r');
      await driver.waitForText('Pick a mode for fake', { timeoutMs: TURN_MS });
      let lines = await driver.lines();
      for (const mode of ['Default', 'Accept edits', 'Plan']) {
        assert.ok(lines.some((line) => line.includes(mode)), `${mode} is offered:\n${lines.join('\n')}`);
      }
      await driver.type('plan\r');
      await driver.waitForText(/fake · Plan · new thread/);

      // /agent: the agents, the default marked, and why the others can't be used.
      await driver.type('/agent\r');
      await driver.waitForText('Pick the agent for new threads');
      lines = await driver.lines();
      assert.ok(lines.some((line) => /Fake Agent\s+default/.test(line)), lines.join('\n'));
      await driver.type('fake\r');
      await driver.waitFor((rows) => !rows.some((row) => row.includes('Pick the agent')), 'the picker closed');
      await close(driver);

      // /here: the next thread lives in the shell's folder.
      await open(driver);
      await driver.type('/here\r');
      await driver.waitForText(/fake · new thread here/);
      await close(driver);
      await driver.type('echo early-command\r');
      await driver.waitForText(/^early-command$/m);
      await ask(driver, 'echo where am i');
      await open(driver);
      await driver.type('/threads\r');
      await driver.waitForText('Pick a thread');
      lines = await driver.lines();
      const here = lines.find((line) => line.includes('echo where am i'));
      assert.ok(here && !here.includes('shelly home'), `rooted in the folder: ${here}`);
      await driver.press('esc');
      await driver.waitFor((rows) => !rows.some((row) => row.includes('Pick a thread')), 'the picker closed');
      await close(driver);

      // /context: what the next message would carry.
      await driver.type('echo fresh-command\r');
      await driver.waitForText(/^fresh-command$/m);
      await open(driver);
      await driver.type('/context\r');
      lines = await driver.waitFor((rows) => rows.some((row) => row.startsWith('With your next message')) && atPrompt(rows), 'the context', { timeoutMs: TURN_MS });
      const context = lines.slice(lines.findIndex((row) => row.startsWith('With your next message')));
      assert.ok(context.some((row) => row.includes('$ echo fresh-command')), context.join('\n'));
      assert.ok(!context.some((row) => row.includes('$ echo early-command')), `only what the thread has not heard:\n${context.join('\n')}`);

      // /help: commands and keys.
      await open(driver);
      await driver.type('/help\r');
      lines = await driver.waitFor((rows) => rows.some((row) => row.includes('While the agent works')) && atPrompt(rows), 'the help');
      for (const command of ['/new', '/here', '/threads', '/agent', '/mode', '/rename', '/context', '/help']) {
        assert.ok(lines.some((row) => row.trimStart().startsWith(command)), `${command} is listed`);
      }
    });
  });
}
