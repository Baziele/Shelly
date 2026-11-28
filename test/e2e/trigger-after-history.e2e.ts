import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, describe, it } from 'node:test';
import { lastPromptRow, startShelly, type ShellyHarness } from './harness.js';

/*
 * The triggers (`::`, `__`) on a line the trigger detector lost track of:
 * after history recall, Shelly asks the shell whether the line is empty
 * before it lets a trigger through, so clearing the recalled line brings the
 * triggers back, and a trigger typed after text stays text. bash 3.2 cannot
 * be asked, so there the triggers stay off until a fresh line. Add shells
 * with SHELLY_E2E_SHELLS (colon-separated paths).
 */

const UP = '\u001b[A';
const CTRL_U = '\u0015';
const BACKSPACE = '\u007f';
const ESCAPE = '\u001b';

const STARTUP_FILES: Record<string, Record<string, string>> = {
  zsh: { '.zshrc': "PS1='$ '\n" },
  bash: { '.bashrc': "PS1='$ '\n" },
  fish: {
    '.config/fish/config.fish': "function fish_prompt; echo -n '$ '; end\nfunction fish_greeting; end\nset -g fish_autosuggestion_enabled 0\n",
  },
};

const shells = ['/bin/zsh', '/bin/bash', ...(process.env.SHELLY_E2E_SHELLS?.split(':').filter(Boolean) ?? [])]
  .filter((shell) => existsSync(shell) && basename(shell) in STARTUP_FILES);

const bashVersion = (shell: string): number =>
  Number(execFileSync(shell, ['-c', 'echo "${BASH_VERSINFO[0]}.${BASH_VERSINFO[1]}"'], { encoding: 'utf8' }).trim());

const promptRow = (rows: string[]): string => rows[lastPromptRow(rows)]?.trimEnd() ?? '';

/** Milliseconds from sending `key` until the shell has echoed it. */
const echoTime = async (session: ShellyHarness, key: string): Promise<number> => {
  const before = session.raw().length;
  const started = performance.now();
  await session.driver.type(key, { perCharDelayMs: 0 });
  while (!session.raw().slice(before).includes(key) && performance.now() - started < 2000) {
    await sleep(1);
  }
  return performance.now() - started;
};

for (const shell of shells) {
  const kind = basename(shell);
  const canAsk = kind !== 'bash' || bashVersion(shell) >= 4;

  describe(`the triggers after history recall in ${shell}`, { timeout: 60_000 }, () => {
    let shelly: ShellyHarness | undefined;
    let home: string | undefined;

    /** Start, run `echo recalled` so there is something to recall, and recall it. */
    const startRecalled = async (): Promise<ShellyHarness> => {
      home = mkdtempSync(join(tmpdir(), 'shelly-triggers-'));
      for (const [file, content] of Object.entries(STARTUP_FILES[kind] ?? {})) {
        mkdirSync(dirname(join(home, file)), { recursive: true });
        writeFileSync(join(home, file), content);
      }
      shelly = await startShelly({ cols: 100, rows: 20, shell, home });
      // fish asks the terminal a few things before it reads keys.
      await sleep(300);
      await shelly.type('echo recalled\r');
      await shelly.waitFor((rows) => rows.includes('recalled') && promptRow(rows) === '$', 'the first command');
      await shelly.type(UP);
      await shelly.waitFor((rows) => promptRow(rows) === '$ echo recalled', 'the recalled line');
      return shelly;
    };

    afterEach(async () => {
      await shelly?.close();
      shelly = undefined;
      if (home) {
        rmSync(home, { recursive: true, force: true });
      }
    });

    if (canAsk) {
      it('opens the input with :: once Ctrl+U has emptied the recalled line', async () => {
        const session = await startRecalled();
        await session.type(CTRL_U);
        await session.waitFor((rows) => promptRow(rows) === '$', 'the emptied line');
        await session.type('::');
        await session.waitFor((rows) => promptRow(rows).startsWith('$ :: Ask'), 'the input');
        await session.type(ESCAPE);
        await session.waitFor((rows) => promptRow(rows) === '$', 'the empty line back');
        // Nothing went to the shell: no `::` there, and nothing ran.
        await session.type('echo after\r');
        const screen = await session.waitFor((rows) => rows.includes('after'), 'the next command');
        assert.ok(!screen.some((row) => /not found|Unknown command/.test(row)), screen.join('\n'));
      });

      it('opens the input with __ once backspacing has emptied the recalled line', async () => {
        const session = await startRecalled();
        await session.type(BACKSPACE.repeat('echo recalled'.length));
        await session.waitFor((rows) => promptRow(rows) === '$', 'the emptied line');
        await session.type('__');
        await session.waitFor((rows) => promptRow(rows).startsWith('$ __ Describe'), 'the input');
        await session.type(ESCAPE);
        await session.waitFor((rows) => promptRow(rows) === '$', 'the empty line back');
      });
    } else {
      it('keeps the triggers off until a fresh line, as bash 3.2 cannot be asked', async () => {
        const session = await startRecalled();
        await session.type(CTRL_U);
        await session.waitFor((rows) => promptRow(rows) === '$', 'the emptied line');
        await session.type('::');
        await session.waitFor((rows) => promptRow(rows) === '$ ::', 'the keys on the line');
        await session.type(`${CTRL_U}\r::`);
        await session.waitFor((rows) => promptRow(rows).startsWith('$ :: Ask'), 'the input on a fresh line');
      });
    }

    it('leaves :: typed after the recalled text on the line, exactly as typed, without lag', async (t) => {
      const session = await startRecalled();
      // A key Shelly never holds, then one it asks the shell about.
      const plain = await echoTime(session, 'x');
      await session.type(BACKSPACE);
      await session.waitFor((rows) => promptRow(rows) === '$ echo recalled', 'the recalled line');
      const asked = await echoTime(session, ':');
      t.diagnostic(`${kind}: x echoed in ${plain.toFixed(1)} ms, : in ${asked.toFixed(1)} ms`);
      // A few milliseconds when the machine is idle. The bound only catches a
      // hold that waits out something (the whole query timeout is 100 ms);
      // a loaded test run lags every timer.
      assert.ok(asked < 400, `: took ${asked} ms`);
      await session.type(':');
      await session.waitFor((rows) => promptRow(rows) === '$ echo recalled::', 'the keys on the line');
      // Well past any hold: the input never opens.
      await sleep(700);
      const screen = await session.screen();
      assert.equal(promptRow(screen), '$ echo recalled::');
      assert.ok(!screen.some((row) => row.includes('Ask Shelly')), screen.join('\n'));
      await session.type('\r');
      await session.waitFor((rows) => rows.includes('recalled::'), 'the command to run as typed');
    });

    it('keeps a quickly typed command with :: in it whole, after the recalled line is emptied', async () => {
      const session = await startRecalled();
      await session.type(CTRL_U);
      await session.waitFor((rows) => promptRow(rows) === '$', 'the emptied line');
      await session.type('echo a::b __c\r');
      const screen = await session.waitFor((rows) => rows.includes('a::b __c'), 'the command to run as typed');
      assert.ok(!screen.some((row) => row.includes('Ask Shelly') || row.includes('Describe a command')), screen.join('\n'));
    });
  });
}
