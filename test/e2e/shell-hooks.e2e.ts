import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, describe, it } from 'node:test';
import xterm from '@xterm/headless';
import * as pty from 'node-pty';
import { prepareShellIntegration } from '../../src/shell/shell-integration.js';
import { ShellMarkerParser, type ShellEvent } from '../../src/shell/shell-markers.js';

/*
 * Drives each shell with Shelly's hooks loaded, but without Shelly itself,
 * and checks the events they report against startup files that have broken
 * hooks before. xterm answers the terminal queries some shells send.
 * Add shells with SHELLY_E2E_SHELLS (colon-separated paths).
 */

interface HookSession {
  /** Type a line and wait for the prompt to come back. */
  run(line: string): Promise<void>;
  /** Send keys without waiting. */
  press(keys: string): Promise<void>;
  readonly events: ShellEvent[];
  /** Everything printed, markers removed. */
  readonly output: () => string;
  close(): Promise<void>;
}

const startHooks = async (shell: string, files: Record<string, string>, env: Record<string, string> = {}): Promise<HookSession> => {
  const home = mkdtempSync(join(tmpdir(), 'shelly-hooks-'));
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(dirname(join(home, file)), { recursive: true });
    writeFileSync(join(home, file), content);
  }
  const baseEnv = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: home,
    TERM: 'xterm-256color',
    LANG: 'en_US.UTF-8',
    BASH_SILENCE_DEPRECATION_WARNING: '1',
    ...env,
  };
  const integration = prepareShellIntegration(shell, baseEnv);
  assert.ok(integration, `no hooks for ${shell}`);

  const terminal = new xterm.Terminal({ cols: 100, rows: 30, allowProposedApi: true });
  const child = pty.spawn(shell, [...integration.args], { cols: 100, rows: 30, cwd: home, env: { ...baseEnv, ...integration.env } });
  const exited = new Promise<void>((resolve) => child.onExit(() => resolve()));
  const parser = new ShellMarkerParser(integration.nonce);
  const events: ShellEvent[] = [];
  let output = '';
  let prompts = 0;
  child.onData((data) => {
    terminal.write(data);
    for (const segment of parser.push(data)) {
      if (segment.type === 'output') {
        output += segment.data;
      } else {
        events.push(segment.event);
        if (segment.event.type === 'cwd') {
          prompts++;
        }
      }
    }
  });
  terminal.onData((reply) => child.write(reply));

  const waitForPrompt = async (count: number): Promise<void> => {
    for (let attempt = 0; attempt < 100 && prompts < count; attempt++) {
      await sleep(50);
    }
    assert.ok(prompts >= count, `no prompt came back; output so far:\n${output}`);
  };
  await waitForPrompt(1);

  return {
    events,
    output: () => output,
    async run(line) {
      const expected = prompts + 1;
      child.write(`${line}\r`);
      await waitForPrompt(expected);
    },
    async press(keys) {
      child.write(keys);
      await sleep(300);
    },
    async close() {
      child.kill();
      await Promise.race([exited, sleep(2000)]);
      terminal.dispose();
      rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
};

const commands = (events: ShellEvent[]): string[] =>
  events.flatMap((event) => (event.type === 'exec' ? [event.command] : []));

const shells = ['/bin/zsh', '/bin/bash', ...(process.env.SHELLY_E2E_SHELLS?.split(':').filter(Boolean) ?? [])]
  .filter((shell) => existsSync(shell));
const ofKind = (kind: string): string[] => shells.filter((shell) => basename(shell) === kind);

for (const shell of ofKind('zsh')) {
  describe(`zsh hooks in ${shell}`, { timeout: 60_000 }, () => {
    let session: HookSession | undefined;
    afterEach(async () => {
      await session?.close();
      session = undefined;
    });

    it("runs the user's startup files at top level, with their usual scoping", async () => {
      session = await startHooks(shell, {
        '.zshrc': [
          'typeset -A STYLES; STYLES[a]=1',
          'typeset MYVAR=hello',
          "trap 'echo EXIT-TRAP-FIRED' EXIT",
          'typeset -U path; path=(/opt/fake $path)',
          "PS1='$ '",
        ].join('\n'),
      });
      await session.run('echo "styles=${(t)STYLES} myvar=$MYVAR path1=$path[1]"');
      assert.match(session.output(), /styles=association[-a-z]* myvar=hello path1=\/opt\/fake/);
      assert.ok(!session.output().includes('EXIT-TRAP-FIRED'), 'an EXIT trap set in .zshrc does not fire at startup');
    });

    it('keeps working under options that change how scripts behave', async () => {
      session = await startHooks(shell, {
        '.zshrc': "setopt nounset ksh_arrays warn_create_global\nmine() { print -n ''; }\nprecmd_functions+=(mine)\nPS1='$ '\n",
      });
      await session.run('echo ok');
      await session.run('print -l -- "${precmd_functions[@]}"');
      assert.deepEqual(commands(session.events), ['echo ok', 'print -l -- "${precmd_functions[@]}"']);
      assert.match(session.output(), /__shelly_precmd\r\nmine\r\n/, "the user's own precmd still runs");
      assert.ok(!/parameter not set|created globally/.test(session.output()), session.output());
    });

    it('reports exit status, directory and awkward command lines', async () => {
      session = await startHooks(shell, { '.zshrc': "PS1='$ '\n" });
      await session.run('false');
      await session.run('cd /');
      await session.run('echo "100% \\\\ ünï"');
      assert.deepEqual(session.events.filter((event) => event.type === 'done').map((event) => event.exitCode).slice(-3), [1, 0, 0]);
      assert.deepEqual(session.events.filter((event) => event.type === 'cwd').at(-1), { type: 'cwd', path: '/' });
      assert.equal(commands(session.events).at(-1), 'echo "100% \\\\ ünï"');
    });
  });
}

for (const shell of ofKind('bash')) {
  describe(`bash hooks in ${shell}`, { timeout: 60_000 }, () => {
    let session: HookSession | undefined;
    afterEach(async () => {
      await session?.close();
      session = undefined;
    });

    it("keeps a PROMPT_COMMAND that ends in ';' or a comment working", async () => {
      for (const promptCommand of ['history -a; ', 'echo PC-RAN # sync']) {
        session = await startHooks(shell, { '.bashrc': `PS1='$ '\nPROMPT_COMMAND='${promptCommand}'\n` });
        await session.run('echo one');
        assert.deepEqual(commands(session.events), ['echo one'], promptCommand);
        assert.ok(!session.output().includes('syntax error'), session.output());
        await session.close();
        session = undefined;
      }
    });

    it('starts cleanly under set -u', async () => {
      session = await startHooks(shell, { '.bashrc': "set -u\nPS1='$ '\n" });
      await session.run('echo one');
      assert.deepEqual(commands(session.events), ['echo one']);
      assert.ok(!session.output().includes('unbound variable'), session.output());
    });

    it('names repeats, but not commands kept out of history', async () => {
      session = await startHooks(
        shell,
        { '.bashrc': "PS1='$ '\nHISTCONTROL=ignoreboth\nHISTIGNORE='secret*'\n", '.bash_history': 'echo from-last-session\n' },
      );
      await session.run(' echo hidden');
      await session.run('echo first');
      await session.run('echo first');
      await session.run('secretcmd() { :; }; secretcmd');
      assert.deepEqual(commands(session.events), ['', 'echo first', ...(usesPs0(shell) ? [''] : ['echo first']), '']);
    });

    // bash 3.2 has bind -x but no READLINE_LINE, so a widget cannot edit the line there.
    it('does not mistake a key binding for a command', { skip: bashVersion(shell) < 4 }, async () => {
      session = await startHooks(shell, { '.bashrc': "PS1='$ '\nwidget() { READLINE_LINE='echo picked'; READLINE_POINT=11; }\nbind -x '\"\\C-t\": widget'\n" });
      await session.run('ls /');
      await session.press('\u0014');
      await session.run('');
      assert.deepEqual(commands(session.events), ['ls /', 'echo picked']);
    });
  });
}

for (const shell of ofKind('fish')) {
  describe(`fish hooks in ${shell}`, { timeout: 60_000 }, () => {
    let session: HookSession | undefined;
    afterEach(async () => {
      await session?.close();
      session = undefined;
    });

    it('keeps the nonce out of what config.fish starts, and reports multi-line commands', async () => {
      session = await startHooks(shell, {
        '.config/fish/config.fish': "function fish_greeting; end\nfunction fish_prompt; echo -n '$ '; end\nset -g seen (env | string match 'SHELLY*')\n",
      });
      await session.run('echo "seen=[$seen]"');
      await session.run("echo 'multi\nline'");
      assert.match(session.output(), /seen=\[\]/);
      assert.deepEqual(commands(session.events), ['echo "seen=[$seen]"', "echo 'multi\nline'"]);
    });
  });
}

/** Major and minor version as a number, e.g. 5.3. */
function bashVersion(shell: string): number {
  return Number(execFileSync(shell, ['-c', 'echo "${BASH_VERSINFO[0]}.${BASH_VERSINFO[1]}"'], { encoding: 'utf8' }).trim());
}

/** bash 4.4+ hooks through PS0, which cannot tell a repeat from a hidden command. */
function usesPs0(shell: string): boolean {
  return bashVersion(shell) >= 4.4;
}
