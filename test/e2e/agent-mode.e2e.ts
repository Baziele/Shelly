import assert from 'node:assert/strict';
import { basename } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { isProcessAlive } from '../../src/daemon/lock.js';
import { lastPromptRow, type ScenarioDriver } from '../tools/scenario.js';
import { E2E_SHELLS, type Stack, startStack } from './stack.js';

/*
 * Agent mode end to end: Shelly in a real pty, the daemon it starts, the
 * real ACP runtime, and the fake ACP agent (fixtures/agent.scenario.ts)
 * as the default agent. Each test drives one terminal through a flow the
 * way a user would, and checks the screen: what is shown, in order, with
 * the prompt given back right below the output.
 */

const TURN_MS = 20_000;

/** The prompt row is the row right after `row`: no blank line between output and prompt. */
const promptRightAfter = (lines: string[], pattern: RegExp): void => {
  const last = lastPromptRow(lines);
  const before = lines[last - 1] ?? '';
  assert.match(before, pattern, `the row above the prompt; screen:\n${lines.join('\n')}`);
};

/** A failed turn's footer: the failure (wrapped, if long), a hint, then one blank row before the prompt. */
const failureBeforePrompt = (lines: string[], pattern: RegExp): void => {
  const last = lastPromptRow(lines);
  const screen = `screen:\n${lines.join('\n')}`;
  assert.equal(lines[last - 1]?.trim(), '', `a blank row above the prompt; ${screen}`);
  assert.match(lines[last - 2] ?? '', /Try again, or check that .+ works on its own\./, `the hint above it; ${screen}`);
  assert.ok(lines.slice(Math.max(0, last - 6), last - 2).some((line) => pattern.test(line)), `the failure above that; ${screen}`);
};

/** No escape sequence or control character leaked onto the screen as text. */
const assertClean = (lines: string[]): void => {
  for (const line of lines) {
    assert.ok(!/[\u0000-\u0008\u000b-\u001f\u007f]|\^\[/.test(line), `a stray control character in: ${JSON.stringify(line)}`);
  }
};

const atPrompt = (lines: string[]): boolean => lines[lastPromptRow(lines)]?.trimEnd() === '$';

/** Type a prompt into `::` and wait for its turn to end and the prompt to come back. */
const ask = async (driver: ScenarioDriver, text: string, done: RegExp | string = /[✓◼✗] /): Promise<string[]> => {
  await driver.type('::');
  await driver.waitForText(':: Ask Shelly', { timeoutMs: 10_000 });
  await driver.type(text);
  await driver.press('enter');
  await waitForTurnEnd(driver, text, done);
  return promptLineStaysEmpty(driver);
};

/** The prompt after a turn holds nothing but the prompt, also a moment later (a stray terminal reply would show up as `3R`). */
const promptLineStaysEmpty = async (driver: ScenarioDriver): Promise<string[]> => {
  await sleep(300);
  const lines = await driver.lines();
  assert.equal(lines[lastPromptRow(lines)]?.trimEnd(), '$', `the prompt line holds only the prompt:\n${lines.join('\n')}`);
  return lines;
};

const waitForTurnEnd = (driver: ScenarioDriver, text: string, done: RegExp | string): Promise<string[]> =>
  driver.waitFor((lines) => {
    const echo = lines.findLastIndex((line) => line.startsWith(`$ :: ${text}`));
    const end = lines.findLastIndex((line) => (typeof done === 'string' ? line.includes(done) : done.test(line)));
    return echo >= 0 && end > echo && atPrompt(lines) && lastPromptRow(lines) > end;
  }, `the turn for "${text}" to end`, { timeoutMs: TURN_MS, scrollback: true });

for (const shell of E2E_SHELLS) {
  describe(`agent mode in ${basename(shell)}`, { timeout: 120_000 }, () => {
    let stack: Stack | undefined;

    const start = async (cols = 100, rows = 30): Promise<ScenarioDriver> => {
      stack = await startStack({ shell, cols, rows });
      return stack.driver;
    };

    afterEach(async () => {
      await stack?.stop();
      stack = undefined;
    });

    it('answers in markdown and with tools, and sends a follow-up only the new commands', async () => {
      const driver = await start();
      await driver.type('echo first-command\r');
      await driver.waitForText(/^first-command$/m);

      await driver.type('::');
      await driver.waitForText(/Fake Agent · new thread/, { timeoutMs: 15_000 });
      await driver.press('esc');
      await driver.waitFor(atPrompt, 'the prompt back');

      let lines = await ask(driver, 'show me markdown', '✓');
      assert.ok(lines.some((line) => line.includes('Table')), 'the markdown answer');
      promptRightAfter(lines, /✓ (<1s|\d)/);
      assertClean(lines);

      lines = await ask(driver, 'run the tools', '✓');
      assert.ok(lines.some((line) => /✓ .* · \d+ tools/.test(line)), `a summary counting tools:\n${lines.join('\n')}`);
      promptRightAfter(lines, /✓ /);

      await driver.type('echo second-command\r');
      await driver.waitForText(/^second-command$/m);
      await driver.type('::');
      await driver.waitForText(/Fake Agent · “show me markdown”/);
      await driver.type('echo it back');
      await driver.press('enter');
      await waitForTurnEnd(driver, 'echo it back', '✓');

      const prompts = stack!.promptLog.trim().split('\n').map((line) => JSON.parse(line) as { sessionId: string; text: string });
      assert.equal(prompts.length, 3);
      assert.equal(new Set(prompts.map((prompt) => prompt.sessionId)).size, 1, 'one thread, one agent session');
      assert.match(prompts[0]!.text, /\$ echo first-command/, 'the first message carries the recent commands');
      assert.match(prompts[1]!.text, /No new commands since the last message/);
      assert.match(prompts[2]!.text, /\$ echo second-command/, 'a follow-up carries what ran since');
      assert.doesNotMatch(prompts[2]!.text, /first-command/, '…and nothing the agent already heard');
      assert.match(prompts[2]!.text, /echo it back$/);
    });

    it('asks for permission and takes the answer from the keyboard', async () => {
      const driver = await start();
      const permission = async (text: string, key: string, outcome: RegExp): Promise<void> => {
        await driver.type('::');
        await driver.waitForText(':: Ask Shelly', { timeoutMs: 10_000 });
        await driver.type(text);
        await driver.press('enter');
        await driver.waitForText('Fake Agent wants to: Edit .env.example', { timeoutMs: TURN_MS });
        await driver.waitForText(/Waiting for you/);
        // A prompt ignores keys for its first 300 ms on screen, so a key typed ahead cannot answer it.
        await sleep(500);
        await driver.type(key);
        const lines = await waitForTurnEnd(driver, text, '✓');
        assert.ok(lines.some((line) => outcome.test(line)), `${outcome}:\n${lines.join('\n')}`);
        assert.ok(!lines.some((line) => line.includes('wants to:')), 'the question is gone once answered');
        promptRightAfter(lines, /✓ /);
      };
      await permission('permission once', 'y', /allowed once/);
      await permission('permission always', '2', /won't ask again/);
      await permission('permission no', 'n', /left `?\.env\.example`? alone/);
    });

    it('stops on Ctrl-C, and goes to the background on Esc to be watched later', async () => {
      const driver = await start();
      await driver.type('::slow build\r');
      await driver.waitForText('Running make', { timeoutMs: TURN_MS });
      await driver.press('ctrl-c');
      let lines = await waitForTurnEnd(driver, 'slow build', '◼ Stopped');
      promptRightAfter(lines, /◼ Stopped/);

      await driver.type('::marathon build\r');
      await driver.waitForText('Running make', { timeoutMs: TURN_MS });
      await driver.press('esc');
      lines = await driver.waitFor(
        (rows) => rows.some((row) => row.includes('Fake Agent is still working')) && atPrompt(rows),
        'the note and the prompt back at once',
      );
      promptRightAfter(lines, /Fake Agent is still working/);

      // The shell is the user's again while the agent works.
      await driver.type('echo meanwhile\r');
      await driver.waitForText(/^meanwhile$/m);

      // A second request while it runs is refused, keeping what was typed, and says how to watch.
      await driver.type('::');
      await driver.waitForText(/● Fake Agent is working · enter to see/);
      await driver.type('another question\r');
      await driver.waitForText(/still working on your last request · empty the line, then enter to see/);
      lines = await driver.lines();
      assert.match(lines[lastPromptRow(lines)] ?? '', /^\$ :: another question/, 'the input stays, with the text');
      await driver.press('backspace', 'another question'.length);
      await driver.waitForText(/● Fake Agent is working · enter to see/);
      await driver.press('enter');
      lines = await driver.waitFor(
        (rows) => rows.some((row) => row.includes(':: marathon build · watching')) && rows.some((row) => row.includes('The build passed'))
          && atPrompt(rows),
        'the turn, watched to its end',
        { timeoutMs: TURN_MS },
      );
      promptRightAfter(lines, /✓ /);
      assertClean(lines);
    });

    it('leaves nothing on the prompt line after a turn, however fast the request is typed', async () => {
      const driver = await start();
      for (let turn = 1; turn <= 3; turn++) {
        // All at once, as a paste (or a fast typist over a slow link) delivers it.
        await driver.type(`::turn ${turn}\r`, { perCharDelayMs: 0 });
        await waitForTurnEnd(driver, `turn ${turn}`, '✓');
        await promptLineStaysEmpty(driver);
      }
      await driver.type('echo still clean\r');
      await driver.waitForText(/^still clean$/m);
      assert.ok(!(await driver.lines({ scrollback: true })).some((line) => /command not found|\d+R$/.test(line)), 'no reply ran as a command');
    });

    it('keeps the whole of a long answer in scrollback, in order, with nothing stray', async () => {
      const driver = await start(90, 20);
      await ask(driver, 'a long answer please', '✓');
      const all = await driver.lines({ scrollback: true });
      const numbered = all.filter((line) => /line \d{3} of the long answer/.test(line));
      assert.deepEqual(
        numbered.map((line) => Number(/line (\d{3})/.exec(line)![1])),
        Array.from({ length: 120 }, (_, i) => i + 1),
        'every line once, in order',
      );
      const first = all.findIndex((line) => line.includes('line 001'));
      const last = all.findIndex((line) => line.includes('line 120'));
      assert.equal(last - first, 119, 'no blank or repeated rows inside the list');
      assert.ok(all.some((line) => line.includes('That was all of it.')));
      assert.ok(!all.some((line) => line.includes('more lines above')), 'no clipping note left behind');
      assertClean(all);
      promptRightAfter(await driver.lines(), /✓ /);

      // A turn that ends with nothing said says so, rather than a bare ✓, and the prompt follows right after.
      const lines = await ask(driver, 'say nothing', 'Fake Agent ended the turn without a reply');
      assert.ok(!lines.slice(lines.findLastIndex((line) => line.includes(':: say nothing'))).some((line) => /^[✓◼] /.test(line)), lines.join('\n'));
      promptRightAfter(lines, /\S/);
    });

    it('says with ✗ when the agent is signed out, and retries in the same thread', async () => {
      const driver = await start();
      const signedOut = /^✗ Fake Agent isn't signed in\. Sign in to it, then try again\./;
      for (const text of ['pretend signed out', 'pretend signed out again']) {
        await driver.type(`::${text}\r`);
        const lines = await waitForTurnEnd(driver, text, signedOut);
        const echo = lines.findLastIndex((line) => line.startsWith(`$ :: ${text}`));
        assert.ok(!lines.slice(echo).some((line) => /^✓ /.test(line)), lines.join('\n'));
      }
      await driver.type('::/threads\r');
      await driver.waitForText('Pick a thread', { timeoutMs: TURN_MS });
      const lines = await driver.lines();
      assert.equal(lines.filter((line) => /pretend signed out\s+Fake Agent/.test(line)).length, 1, lines.join('\n'));
      assert.ok(!lines.some((line) => line.includes('Untitled thread')), lines.join('\n'));
      await driver.press('esc');
      await sleep(300);
      await driver.press('esc');
      await driver.waitFor(atPrompt, 'the prompt back');
    });

    it('reflows when the terminal is resized mid-turn', async () => {
      const driver = await start(100, 24);
      await driver.type('::slow resize\r');
      await driver.waitForText('Running make', { timeoutMs: TURN_MS });
      await driver.resize(70, 20);
      await sleep(200);
      await driver.resize(84, 22);
      const lines = await waitForTurnEnd(driver, 'slow resize', '✓');
      assert.ok(lines.some((line) => line.includes('The build passed')));
      assert.equal(lines.filter((line) => /Running make|esc background/.test(line)).length, 0, 'no live rows left behind');
      promptRightAfter(lines, /✓ /);
      assertClean(lines);
    });

    it('keeps its output when the idle shell redraws its prompt meanwhile', { skip: basename(shell) !== 'zsh' && 'a zsh prompt that redraws itself' }, async () => {
      // A two-line prompt redrawn every second, as fish 3 does on a resize and async prompts do:
      // each redraw moves the cursor up from where the shell thinks its prompt is.
      stack = await startStack({
        shell,
        cols: 90,
        rows: 20,
        files: { '.zshrc': "PS1=$'top\\n$ '\nTMOUT=1\nTRAPALRM() { zle reset-prompt }\n" },
      });
      const driver = stack.driver;
      await driver.type('::slow redraws\r');
      const lines = await driver.waitFor(
        (rows) => rows.some((row) => row.includes('The build passed')) && rows.some((row) => /^✓ /.test(row)) && atPrompt(rows),
        'the turn to end and the prompt to come back',
        { timeoutMs: TURN_MS },
      );
      const summary = lines.findIndex((row) => /^✓ /.test(row));
      assert.deepEqual(lines.slice(summary, summary + 3).map((row) => row.trimEnd()), [lines[summary]!.trimEnd(), 'top', '$'], lines.join('\n'));
      assert.equal(lines.filter((row) => row.trimEnd() === 'top').length, 2, 'one prompt before the request, one after');
    });

    it('starts the daemon on demand, and carries on after it is killed', async () => {
      const driver = await start();
      // Straight away: the daemon is started by the first prompt, or by this.
      await ask(driver, 'echo hello', '✓');
      const first = stack!.daemonPid();
      assert.ok(first && isProcessAlive(first), 'a daemon is running');

      // Killed between turns: the next prompt starts a new one and attaches again.
      process.kill(first!, 'SIGKILL');
      await sleep(200);
      await ask(driver, 'echo again', '✓');
      const second = stack!.daemonPid();
      assert.ok(second && second !== first && isProcessAlive(second), 'a new daemon');

      // Killed mid-turn: the turn ends saying so, and the prompt comes back.
      await driver.type('::slow and doomed\r');
      await driver.waitForText('Running make', { timeoutMs: TURN_MS });
      process.kill(second!, 'SIGKILL');
      const lines = await waitForTurnEnd(driver, 'slow and doomed', '✗ Interrupted');
      assert.ok(lines.some((line) => line.includes("Lost the connection to Shelly's background service")), lines.join('\n'));
      failureBeforePrompt(lines, /✗ Interrupted/);

      // And the thread still works.
      await ask(driver, 'echo still here', '✓');
    });
  });
}
