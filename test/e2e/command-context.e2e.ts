import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { lastPromptRow, startShelly, type ShellyHarness, type ShellyOptions } from './harness.js';

/*
 * Runs real shells with Shelly's hooks, each with a throwaway HOME whose
 * startup files set a `$ ` prompt and an alias. zsh and bash come with macOS;
 * point SHELLY_E2E_SHELLS at more (colon-separated paths, e.g. a newer bash
 * or fish) to cover them too.
 */

const STARTUP_FILES: Record<string, Record<string, string>> = {
  // macOS's /etc/zshrc sets HISTFILE this way and Linux distributions do
  // not; setting it the same way here keeps the history test portable while
  // still catching a ZDOTDIR that leaked from Shelly's shim.
  zsh: { '.zshrc': "PS1='$ '\nalias hi='echo from-rc'\nHISTFILE=${HISTFILE:-${ZDOTDIR:-$HOME}/.zsh_history}\n" },
  bash: { '.bashrc': "PS1='$ '\nalias hi='echo from-rc'\n" },
  fish: {
    '.config/fish/config.fish': "function fish_prompt; echo -n '$ '; end\nfunction fish_greeting; end\nalias hi 'echo from-rc'\n",
  },
};

const shells = ['/bin/zsh', '/bin/bash', ...(process.env.SHELLY_E2E_SHELLS?.split(':').filter(Boolean) ?? [])]
  .filter((shell) => existsSync(shell));

const MARKER = '\u001b]6973';

for (const shell of shells) {
  const kind = basename(shell);

  describe(`command context in ${shell}`, { timeout: 60_000 }, () => {
    let shelly: ShellyHarness | undefined;
    let home: string | undefined;

    const start = async (options: ShellyOptions & { files?: Record<string, string> } = {}): Promise<ShellyHarness> => {
      home = mkdtempSync(join(tmpdir(), 'shelly-e2e-'));
      for (const [file, content] of Object.entries(options.files ?? STARTUP_FILES[kind] ?? {})) {
        mkdirSync(dirname(join(home, file)), { recursive: true });
        writeFileSync(join(home, file), content);
      }
      shelly = await startShelly({ cols: 120, rows: 40, shell, home, ...options, env: { ...options.env } });
      return shelly;
    };

    afterEach(async () => {
      await shelly?.close();
      shelly = undefined;
      if (home) {
        rmSync(home, { recursive: true, force: true });
      }
    });

    it("loads the user's own startup files", async () => {
      const session = await start();
      await session.type('hi\r');
      await session.waitFor((rows) => rows.includes('from-rc'), 'the alias from the startup file');
    });

    it('records commands and their output for /context, and nothing reaches the terminal', async () => {
      const session = await start();
      await session.type('echo one\r');
      await session.waitFor((rows) => rows.includes('one'), 'echo');
      await session.type("printf 'working\\rdone   \\n'\r");
      await session.waitFor((rows) => rows.some((row) => row.trimEnd() === 'done'), 'printf');
      await session.type('false\r');
      await session.type(' echo hidden\r');
      await session.waitFor((rows) => rows.includes('hidden'), 'the private command');

      await session.type('::/context\r');
      const screen = await session.waitFor(
        (rows) => rows.some((row) => row.startsWith('$ false')) && rows[lastPromptRow(rows)]?.trimEnd() === '$',
        'the context and a new prompt',
      );
      const context = screen.slice(screen.indexOf('$ :: /context'));

      assert.ok(context.some((row) => row.startsWith(`Shell: `)), `environment is described; screen:\n${screen.join('\n')}`);
      assert.ok(context.some((row) => row.startsWith('Working directory: ')), 'working directory is reported');
      const after = (line: string, offset: number): string | undefined => context[context.indexOf(line) + offset];
      assert.match(after('$ echo one', 1) ?? '', /^ {2}\[exit 0 · \d+(?:ms|\.\ds) · \//);
      assert.equal(after('$ echo one', 2), '  one');
      assert.equal(after("$ printf 'working\\rdone   \\n'", 2), '  done', 'redrawn output is resolved');
      assert.match(after('$ false', 1) ?? '', /^ {2}\[exit 1 /);
      assert.ok(!context.some((row) => row.includes('hidden')), 'a command typed with a leading space is not recorded');

      assert.ok(!session.raw().includes(MARKER), "Shelly's markers never reach the terminal");
    });

    if (kind === 'zsh') {
      it('hands ZDOTDIR back and keeps history in the usual place', async () => {
        const session = await start();
        await session.type('echo "zdotdir=${ZDOTDIR-unset} histfile=$HISTFILE"\r');
        await session.waitFor(
          (rows) => rows.includes(`zdotdir=unset histfile=${home}/.zsh_history`),
          'the original ZDOTDIR and HISTFILE',
        );
      });

      it("follows a user's custom ZDOTDIR", async () => {
        const dir = mkdtempSync(join(tmpdir(), 'shelly-zdotdir-'));
        try {
          writeFileSync(join(dir, '.zshrc'), "PS1='$ '\nalias hi='echo from-zdotdir'\n");
          const session = await start({ files: {}, env: { ZDOTDIR: dir } });
          await session.type('hi; echo "zdotdir=$ZDOTDIR"\r');
          await session.waitFor(
            (rows) => rows.includes('from-zdotdir') && rows.includes(`zdotdir=${dir}`),
            'the startup file from ZDOTDIR',
          );
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      });
    }
  });
}
