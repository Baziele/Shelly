import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, describe, it } from 'node:test';
import xterm from '@xterm/headless';
import * as pty from 'node-pty';
import { LineEditor } from '../../src/shell/line-editor.js';
import { prepareShellIntegration } from '../../src/shell/shell-integration.js';
import { ShellMarkerParser, type ShellEvent } from '../../src/shell/shell-markers.js';

/*
 * Reads and sets the input line of real shells through their hooks, with
 * LineEditor talking to the shell directly (no Shelly UI in between). Each
 * shell gets a throwaway HOME. Add shells with SHELLY_E2E_SHELLS
 * (colon-separated paths), e.g. a newer bash and fish.
 */

const LEFT = '\u001b[D';
const ESCAPE = '\u001b';

/** Quotes, `$`, `!!`, `%`, a backslash, a tab and an emoji, quoted so that every shell prints them the same. */
const TRICKY = "printf '%s|' \"q'uote\" \"$HOME\" '!!' '%d' 'back\\slash' 'tab\tx' '😀'";
const trickyOutput = (home: string, tab = '\t'): string => `q'uote|${home}|!!|%d|back\\slash|tab${tab}x|😀|`;

interface LineSession {
  readonly editor: LineEditor;
  readonly events: ShellEvent[];
  readonly home: string;
  /** Send keys, then give the shell a moment. */
  press(keys: string, settleMs?: number): Promise<void>;
  /** Wait until the shell has drawn `count` prompts in all. */
  waitForPrompts(count: number): Promise<void>;
  readonly prompts: () => number;
  /** Everything printed, markers removed. */
  readonly output: () => string;
  /** The screen row holding the last prompt. */
  promptRow(): Promise<string>;
  close(): Promise<void>;
}

const STARTUP: Record<string, (extra: string) => Record<string, string>> = {
  zsh: (extra) => ({ '.zshrc': `PS1='$ '\n${extra}\n` }),
  bash: (extra) => ({ '.bashrc': `PS1='$ '\n${extra}\n` }),
  fish: (extra) => ({
    '.config/fish/config.fish': `function fish_greeting; end\nfunction fish_prompt; echo -n '$ '; end\nset -g fish_autosuggestion_enabled 0\n${extra}\n`,
  }),
};

const start = async (shell: string, extra = ''): Promise<LineSession> => {
  const home = mkdtempSync(join(tmpdir(), 'shelly-line-'));
  for (const [file, content] of Object.entries(STARTUP[basename(shell)]!(extra))) {
    mkdirSync(dirname(join(home, file)), { recursive: true });
    writeFileSync(join(home, file), content);
  }
  const env = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: home,
    TERM: 'xterm-256color',
    LANG: 'en_US.UTF-8',
    BASH_SILENCE_DEPRECATION_WARNING: '1',
  };

  let child: pty.IPty | undefined;
  const editor = new LineEditor({ write: (data) => child?.write(data), runtimeDir: home });
  const integration = prepareShellIntegration(shell, env, undefined, editor.lineFile);
  assert.ok(integration, `no hooks for ${shell}`);

  const terminal = new xterm.Terminal({ cols: 100, rows: 30, allowProposedApi: true });
  child = pty.spawn(shell, [...integration.args], { cols: 100, rows: 30, cwd: home, env: { ...env, ...integration.env } });
  const spawned = child;
  const exited = new Promise<void>((resolve) => spawned.onExit(() => resolve()));
  const parser = new ShellMarkerParser(integration.nonce);
  const events: ShellEvent[] = [];
  let output = '';
  let prompts = 0;
  spawned.onData((data) => {
    terminal.write(data);
    for (const segment of parser.push(data)) {
      if (segment.type === 'output') {
        output += segment.data;
        editor.observeOutput(segment.data);
      } else {
        events.push(segment.event);
        editor.handleEvent(segment.event);
        if (segment.event.type === 'cwd') {
          prompts++;
        }
      }
    }
  });
  terminal.onData((reply) => spawned.write(reply));

  const session: LineSession = {
    editor,
    events,
    home,
    output: () => output,
    prompts: () => prompts,
    async press(keys, settleMs = 300) {
      spawned.write(editor.filterInput(keys));
      await sleep(settleMs);
    },
    async waitForPrompts(count) {
      for (let attempt = 0; attempt < 100 && prompts < count; attempt++) {
        await sleep(50);
      }
      assert.ok(prompts >= count, `no prompt came back; output so far:\n${output}`);
    },
    async promptRow() {
      await new Promise<void>((resolve) => terminal.write('', resolve));
      const buffer = terminal.buffer.active;
      const rows = Array.from({ length: 30 }, (_, row) => buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? '');
      return rows.findLast((row) => row.startsWith('$'))?.trimEnd() ?? '';
    },
    async close() {
      spawned.kill();
      await Promise.race([exited, sleep(2000)]);
      editor.dispose();
      terminal.dispose();
      rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
  await session.waitForPrompts(1);
  // fish asks the terminal a few things before it reads keys.
  await sleep(200);
  return session;
};

const execs = (events: ShellEvent[]): string[] => events.flatMap((event) => (event.type === 'exec' ? [event.command] : []));

/** Press Enter and wait for the command to finish. */
const enter = async (session: LineSession): Promise<void> => {
  const prompts = session.prompts();
  await session.press('\r', 0);
  await session.waitForPrompts(prompts + 1);
};

const bashVersion = (shell: string): number =>
  Number(execFileSync(shell, ['-c', 'echo "${BASH_VERSINFO[0]}.${BASH_VERSINFO[1]}"'], { encoding: 'utf8' }).trim());

const shells = ['/bin/zsh', '/bin/bash', ...(process.env.SHELLY_E2E_SHELLS?.split(':').filter(Boolean) ?? [])]
  .filter((shell) => existsSync(shell) && basename(shell) in STARTUP);

const VI_MODE: Record<string, string> = { zsh: 'bindkey -v', bash: 'set -o vi', fish: 'fish_vi_key_bindings' };

/** Ctrl+T runs a widget that keeps the shell busy for a while. */
const SLOW_KEY: Record<string, string> = {
  zsh: 'slow() { sleep 0.6; }\nzle -N slow\nbindkey "^T" slow',
  bash: 'bind -x \'"\\C-t": sleep 0.6\'',
  fish: 'bind ctrl-t "sleep 0.6"',
};

for (const shell of shells) {
  const kind = basename(shell);
  const canEditLine = kind !== 'bash' || bashVersion(shell) >= 4;

  describe(`the input line in ${shell}`, { timeout: 60_000 }, () => {
    let session: LineSession | undefined;
    afterEach(async () => {
      await session?.close();
      session = undefined;
    });

    it('captures a half-typed line and its cursor, clearing it from the screen', { skip: !canEditLine && 'bash 3.2 cannot read its line' }, async () => {
      session = await start(shell);
      assert.equal(session.editor.canCapture, true);
      // No emoji here: shells and xterm.js disagree on its width, which
      // garbles the screen (the replace tests cover emoji).
      const typed = 'echo "a;b" $HOME 100% ünï 日本 \\x';
      await session.press(typed + LEFT.repeat(3));
      assert.equal(await session.promptRow(), `$ ${typed}`);

      const captured = await session.editor.capture();
      assert.deepEqual(captured, { buffer: typed, cursor: typed.length - 3 });
      assert.equal(await session.promptRow(), '$', 'the line is cleared on screen');
      assert.deepEqual(execs(session.events), [], 'nothing ran');

      // Put back, it is the same line with the cursor where it was.
      await session.editor.restore(captured!);
      await sleep(100);
      assert.equal(await session.promptRow(), `$ ${typed}`);
      await session.press('Z');
      const edited = `${typed.slice(0, -3)}Z${typed.slice(-3)}`;
      assert.deepEqual(await session.editor.capture(), { buffer: edited, cursor: edited.length - 3 });
    });

    it('replaces the line with tricky text exactly, without running it', { skip: !canEditLine && 'bash 3.2 types instead' }, async () => {
      session = await start(shell);
      await session.press('ls half-typed');
      await session.editor.replace(TRICKY);
      const captured = await session.editor.capture();
      assert.deepEqual(captured, { buffer: TRICKY, cursor: TRICKY.length });
      assert.deepEqual(execs(session.events), [], 'nothing ran');

      await session.editor.restore(captured!);
      await enter(session);
      assert.ok(session.output().includes(trickyOutput(session.home)), session.output());
      assert.deepEqual(execs(session.events), [TRICKY]);
    });

    it('replaces the line with a multi-line command, and runs all of it on Enter', { skip: !canEditLine && 'bash 3.2 types instead' }, async () => {
      session = await start(shell);
      const text = 'echo one\necho two';
      await session.editor.replace(text);
      assert.deepEqual(await session.editor.capture(), { buffer: text, cursor: text.length });
      await session.editor.replace(text);
      assert.deepEqual(execs(session.events), []);

      await enter(session);
      assert.match(session.output(), /[\r\n]one\r\ntwo\r\n/);
      if (kind !== 'bash') {
        // bash names it from history, which may join the lines.
        assert.deepEqual(execs(session.events), [text]);
      }
    });

    it('sets a line exactly, leading and trailing whitespace and all', { skip: !canEditLine && 'bash 3.2 types instead' }, async () => {
      session = await start(shell);
      for (const text of ['  x\t', 'a  ', ' ', '\t\tindented', 'two  \n  lines\t', 'end\n\n']) {
        await session.editor.replace(text);
        assert.deepEqual(await session.editor.capture(), { buffer: text, cursor: text.length }, JSON.stringify(text));
      }
      assert.deepEqual(execs(session.events), [], 'nothing ran');
    });

    it('fills an empty line', { skip: !canEditLine && 'bash 3.2 types instead' }, async () => {
      session = await start(shell);
      await session.editor.replace('echo filled');
      // The shell redraws right after it answers.
      await sleep(100);
      assert.equal(await session.promptRow(), '$ echo filled');
      await enter(session);
      assert.deepEqual(execs(session.events), ['echo filled']);
    });

    it('works in vi mode, in insert and command mode', { skip: !canEditLine && 'bash 3.2 cannot read its line' }, async () => {
      session = await start(shell, VI_MODE[kind]);
      await session.press('echo vi');
      assert.deepEqual(await session.editor.capture(), { buffer: 'echo vi', cursor: 7 });
      await session.editor.replace('echo vi');

      // Command mode, after the escape key's timeout.
      await session.press(ESCAPE, 800);
      const captured = await session.editor.capture();
      assert.equal(captured?.buffer, 'echo vi');
      await session.editor.replace('echo from-command-mode');
      // Command mode keeps the cursor on the last character.
      assert.deepEqual(await session.editor.capture(), { buffer: 'echo from-command-mode', cursor: 21 });
      await session.editor.replace('echo from-command-mode');
      await enter(session);
      assert.deepEqual(execs(session.events), ['echo from-command-mode']);
    });

    it('leaves a line too long to report where it is', { skip: !canEditLine && 'bash 3.2 cannot read its line' }, async () => {
      session = await start(shell);
      // Over the hooks' limit once percent-encoded.
      const long = `true ${'%'.repeat(20_001)}`;
      await session.editor.replace(long);
      assert.deepEqual(await session.editor.tryCapture(), { status: 'failed', reason: 'too-long' });
      await enter(session);
      assert.equal(execs(session.events).length, 1);
      assert.ok(execs(session.events)[0]!.startsWith('true %%%%'), 'the line was still there to run');
    });

    it('puts back a line the shell clears after Shelly stopped waiting', { skip: !canEditLine && 'bash 3.2 cannot read its line' }, async () => {
      session = await start(shell, SLOW_KEY[kind]);
      await session.press('echo half');
      // Busy in a slow widget of the user's, the shell gets to the capture late.
      await session.press('\u0014', 0);
      assert.deepEqual(await session.editor.tryCapture({ timeoutMs: 100 }), { status: 'failed', reason: 'no-answer' });
      await sleep(1000);
      assert.equal(await session.promptRow(), '$ echo half');
      await enter(session);
      assert.deepEqual(execs(session.events), ['echo half']);
    });

    it('queries the line, leaving it alone, within a few milliseconds', { skip: !canEditLine && 'bash 3.2 cannot read its line' }, async (t) => {
      session = await start(shell);
      assert.equal(session.editor.canQuery, true);
      await session.press(`echo kept${LEFT}`);
      const times: number[] = [];
      for (let round = 0; round < 20; round++) {
        const started = performance.now();
        const result = await session.editor.query();
        times.push(performance.now() - started);
        assert.deepEqual(result, { status: 'captured', line: { buffer: 'echo kept', cursor: 8 } });
      }
      times.sort((a, b) => a - b);
      t.diagnostic(`${kind} query round trip: median ${times[10]!.toFixed(1)} ms, slowest ${times.at(-1)!.toFixed(1)} ms`);
      // About 1-2 ms on an idle machine; this only catches one that spawns a process or waits.
      assert.ok(times[10]! < 50, `median ${times[10]} ms`);
      // bash 5.1+ clears the line before a bind -x widget runs and redraws it after: give it that moment.
      await sleep(100);
      assert.equal(await session.promptRow(), '$ echo kept', `the line is as it was:\n${session.output()}`);
      await session.press('X');
      await enter(session);
      assert.deepEqual(execs(session.events), ['echo kepXt'], 'and so is the cursor');
    });

    it('shows a notice below the line, leaving the line alone', { skip: !canEditLine && 'bash 3.2 has no notices' }, async () => {
      session = await start(shell);
      assert.equal(session.editor.canNotify, true);
      await session.press('echo kept');
      await session.editor.notify('A notice from Shelly');
      await sleep(200);
      assert.ok(session.output().includes('A notice from Shelly'), session.output());
      assert.equal(await session.promptRow(), '$ echo kept');
      await enter(session);
      assert.deepEqual(execs(session.events), ['echo kept']);
    });

    it('leaves no line file behind, and keeps its directory private', async () => {
      session = await start(shell);
      const dir = dirname(session.editor.lineFile ?? '');
      assert.equal(statSync(dir).mode & 0o777, 0o700);
      await session.editor.replace('echo gone');
      assert.deepEqual(readdirSync(dir), []);
      session.editor.dispose();
      assert.ok(!existsSync(dir));
    });

    if (!canEditLine) {
      it('cannot capture, but replaces a single line by typing it', async () => {
        session = await start(shell);
        assert.equal(session.editor.canCapture, false);
        assert.equal(session.editor.canReplace, true);
        assert.equal(await session.editor.capture(), undefined);

        await session.press('ls half-typed');
        await session.editor.replace(TRICKY);
        await sleep(300);
        assert.deepEqual(execs(session.events), [], 'nothing ran');
        await enter(session);
        // Typed raw, the tab became a space.
        assert.ok(session.output().includes(trickyOutput(session.home, ' ')), session.output());
        await assert.rejects(session.editor.replace('echo one\necho two'), /single-line/);
      });

      it('clears the line from vi command mode too', async () => {
        session = await start(shell, VI_MODE[kind]);
        await session.press('ls half-typed');
        await session.press(ESCAPE, 800);
        await session.editor.replace('echo typed');
        await enter(session);
        assert.match(session.output(), /\r\ntyped\r\n/);
      });
    }
  });
}

describe('the input line under hostile startup files', { timeout: 60_000 }, () => {
  let session: LineSession | undefined;
  afterEach(async () => {
    await session?.close();
    session = undefined;
  });

  for (const shell of shells.filter((candidate) => basename(candidate) === 'zsh')) {
    it(`survives options that change how scripts behave in ${shell}`, async () => {
      session = await start(shell, 'setopt nounset ksh_arrays warn_create_global no_multibyte err_return\nalias rm="rm -i"');
      await session.press('echo ünï');
      const captured = await session.editor.capture();
      assert.deepEqual(captured, { buffer: 'echo ünï', cursor: 8 });
      await session.editor.restore(captured!);
      await enter(session);
      assert.deepEqual(execs(session.events), ['echo ünï']);
      assert.ok(!/parameter not set|created globally|remove /.test(session.output()), session.output());
    });
  }

  for (const shell of shells.filter((candidate) => basename(candidate) === 'bash' && bashVersion(candidate) >= 4)) {
    it(`survives set -u, failglob and aliases in ${shell}`, async () => {
      session = await start(shell, 'set -u\nshopt -s failglob nocasematch\nalias rm="rm -i"\nalias read=false');
      await session.press('echo ünï');
      const captured = await session.editor.capture();
      assert.deepEqual(captured, { buffer: 'echo ünï', cursor: 8 });
      await session.editor.restore(captured!);
      await enter(session);
      assert.deepEqual(execs(session.events), ['echo ünï']);
      assert.ok(!/unbound variable|no match|remove /.test(session.output()), session.output());
    });
  }
});
