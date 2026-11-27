import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, describe, it } from 'node:test';
import { lastPromptRow, startShelly, type ShellyHarness } from './harness.js';

/*
 * The rewrite hotkey (Ctrl+]) in Shelly, end to end: at the prompt it takes
 * the half-typed line into Shelly's input and puts it back afterwards;
 * anywhere else it reaches the program untouched. Add shells with
 * SHELLY_E2E_SHELLS (colon-separated paths).
 */

const HOTKEY = '\u001d';
const LEFT = '\u001b[D';
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

for (const shell of shells) {
  const kind = basename(shell);
  const canCapture = kind !== 'bash' || bashVersion(shell) >= 4;

  describe(`the rewrite hotkey in ${shell}`, { timeout: 60_000 }, () => {
    let shelly: ShellyHarness | undefined;
    let home: string | undefined;
    /** Shelly's TMPDIR, where the line file's directory goes. */
    let temp: string | undefined;

    const start = async (): Promise<ShellyHarness> => {
      home = mkdtempSync(join(tmpdir(), 'shelly-rewrite-'));
      temp = mkdtempSync(join(tmpdir(), 'shelly-rewrite-tmp-'));
      for (const [file, content] of Object.entries(STARTUP_FILES[kind] ?? {})) {
        mkdirSync(dirname(join(home, file)), { recursive: true });
        writeFileSync(join(home, file), content);
      }
      shelly = await startShelly({ cols: 100, rows: 20, shell, home, env: { TMPDIR: temp } });
      // fish asks the terminal a few things before it reads keys.
      await sleep(300);
      return shelly;
    };

    const lineDirs = (): string[] => readdirSync(temp ?? '').filter((name) => name.startsWith('shelly-'));

    afterEach(async () => {
      await shelly?.close();
      shelly = undefined;
      for (const dir of [home, temp]) {
        if (dir) {
          rmSync(dir, { recursive: true, force: true });
        }
      }
    });

    if (canCapture) {
      it('takes the half-typed line into the input, and puts it back on Escape', async () => {
        const session = await start();
        await session.type(`echo half${LEFT}${LEFT}`);
        await session.waitFor((rows) => promptRow(rows) === '$ echo half', 'the typed line');

        await session.type(HOTKEY);
        await session.waitFor((rows) => promptRow(rows).startsWith('$ __') && !rows.some((row) => row.includes('echo half')), 'the input, in place of the line');

        await session.type(ESCAPE);
        await session.waitFor((rows) => promptRow(rows) === '$ echo half', 'the line put back');
        // With the cursor where it was.
        await session.type('X');
        await session.waitFor((rows) => promptRow(rows) === '$ echo haXlf', 'typing mid-line');
        await session.type('\r');
        await session.waitFor((rows) => rows.includes('haXlf'), 'the command to run');

        const [dir] = lineDirs();
        assert.ok(dir, 'the line file has a private directory');
        assert.equal(statSync(join(temp ?? '', dir)).mode & 0o777, 0o700);
        assert.deepEqual(readdirSync(join(temp ?? '', dir)), [], 'and nothing is left in it');
        await session.close();
        assert.deepEqual(lineDirs(), [], 'which goes when Shelly does');
      });

      it('puts the line back on a fresh prompt after a submitted request', async () => {
        const session = await start();
        await session.type('echo half');
        await session.waitFor((rows) => promptRow(rows) === '$ echo half', 'the typed line');
        await session.type(HOTKEY);
        await session.waitFor((rows) => promptRow(rows).startsWith('$ __'), 'the input');
        await session.type('make it louder\r');
        const screen = await session.waitFor(
          (rows) => rows.some((row) => row.startsWith('$ __ make it louder')) && promptRow(rows) === '$ echo half',
          'the transcript and the line on a new prompt',
        );
        assert.ok(screen.some((row) => row.includes("isn't connected to an agent")));
        assert.ok(!screen.includes('half'), 'the line did not run');
        await session.type('\r');
        await session.waitFor((rows) => rows.includes('half'), 'the command to run');
      });
    } else {
      it('opens the input without taking the line, which stays as it is', async () => {
        const session = await start();
        await session.type('echo half');
        await session.waitFor((rows) => promptRow(rows) === '$ echo half', 'the typed line');

        await session.type(HOTKEY);
        await session.waitFor((rows) => promptRow(rows).startsWith('$ echo half__'), 'the input after the line');
        await session.type(ESCAPE);
        await session.waitFor((rows) => promptRow(rows) === '$ echo half', 'the line as it was');

        await session.type(HOTKEY);
        await session.waitFor((rows) => promptRow(rows).startsWith('$ echo half__'), 'the input after the line');
        await session.type('make it louder\r');
        const screen = await session.waitFor(
          (rows) => rows.some((row) => row.includes("isn't connected to an agent")) && promptRow(rows) === '$ echo half',
          'the response and the line redrawn below it',
        );
        assert.ok(!screen.includes('half'), 'the line did not run');
        await session.type('\r');
        await session.waitFor((rows) => rows.includes('half'), 'the command to run');
      });
    }

    it('passes through to a program running in the shell', async () => {
      const session = await start();
      await session.type('cat\r');
      await sleep(300);
      await session.type(`${HOTKEY}x\r`);
      await session.waitFor((rows) => rows.includes('^]x'), 'cat to receive the key');
      await session.type('\u0004');
      await session.waitFor((rows) => promptRow(rows) === '$', 'the prompt after cat');
    });
  });
}
