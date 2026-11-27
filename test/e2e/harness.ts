import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import xterm from '@xterm/headless';
import * as pty from 'node-pty';

const ENTRY = fileURLToPath(new URL('../../src/index.ts', import.meta.url));
// Resolved here, since Shelly may be started from a directory that cannot see this project's packages.
const TSX = import.meta.resolve('tsx');
const PROMPT = '$ ';

export interface ShellyHarness {
  /** Send keystrokes as a terminal would: escape sequences arrive whole. */
  type(keys: string): Promise<void>;
  /** The visible screen, one string per row, trailing spaces trimmed. */
  screen(): Promise<string[]>;
  cursor(): Promise<{ row: number; col: number }>;
  /** Poll the screen until `predicate` holds, or fail with the last screen. */
  waitFor(predicate: (screen: string[]) => boolean, description: string): Promise<string[]>;
  /** Everything Shelly wrote to the terminal so far. */
  raw(): string;
  close(): Promise<number>;
}

export interface ShellyOptions {
  readonly cols?: number;
  readonly rows?: number;
  readonly shell?: string;
  /** A throwaway HOME holding the shell's startup files. */
  readonly home?: string;
  readonly env?: Readonly<Record<string, string>>;
}

/**
 * Runs Shelly in a pseudo-terminal attached to an emulated terminal
 * (xterm.js), which answers cursor position and other queries like a real
 * one. Defaults to plain `sh` with a fixed prompt so results do not depend on
 * the user's shell configuration; other shells should get a throwaway HOME
 * whose startup files set the same prompt.
 */
export const startShelly = async (
  { cols = 80, rows = 12, shell = '/bin/sh', home, env = {} }: ShellyOptions = {},
): Promise<ShellyHarness> => {
  const terminal = new xterm.Terminal({ cols, rows, allowProposedApi: true });
  const child = pty.spawn(process.execPath, ['--experimental-ffi', '--no-warnings', '--import', TSX, ENTRY], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: home ?? process.cwd(),
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: home ?? process.env.HOME ?? '/tmp',
      TERM: 'xterm-256color',
      LANG: 'en_US.UTF-8',
      SHELL: shell,
      PS1: PROMPT,
      // macOS's bash 3.2 otherwise opens with a notice about zsh.
      BASH_SILENCE_DEPRECATION_WARNING: '1',
      ...env,
    },
  });

  let exited: Promise<number> | undefined;
  const exitCode = new Promise<number>((resolve) => child.onExit(({ exitCode: code }) => resolve(code)));
  let raw = '';
  child.onData((data) => {
    raw += data;
    terminal.write(data);
  });
  terminal.onData((reply) => child.write(reply));

  const flush = (): Promise<void> => new Promise((resolve) => terminal.write('', resolve));

  const harness: ShellyHarness = {
    async type(keys) {
      for (const key of keys.match(/\u001b\[[0-9;]*[A-Za-z~]|[\s\S]/gu) ?? []) {
        child.write(key);
        await sleep(15);
      }
    },
    async screen() {
      await flush();
      const buffer = terminal.buffer.active;
      return Array.from({ length: rows }, (_, row) =>
        buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? '');
    },
    async cursor() {
      await flush();
      const buffer = terminal.buffer.active;
      return { row: buffer.cursorY + 1, col: buffer.cursorX + 1 };
    },
    async waitFor(predicate, description) {
      let screen: string[] = [];
      for (let attempt = 0; attempt < 100; attempt++) {
        screen = await harness.screen();
        if (predicate(screen)) {
          return screen;
        }
        await sleep(50);
      }
      throw new Error(`Timed out waiting for ${description}. Screen:\n${screen.join('\n')}`);
    },
    raw: () => raw,
    close() {
      exited ??= (async () => {
        try {
          // Ctrl+C first, in case Shelly's input is still open.
          child.write('\u0003');
          await sleep(100);
          child.write('exit\r');
        } catch {
          // Already gone.
        }
        const code = await Promise.race([exitCode, sleep(3000).then(() => -1)]);
        if (code === -1) {
          child.kill();
        }
        return code;
      })();
      return exited;
    },
  };

  await harness.waitFor((screen) => lastPromptRow(screen) >= 0, 'the shell prompt');
  return harness;
};

/** Index of the last row showing the prompt (rows are trimmed, so an empty prompt is just `$`). */
export const lastPromptRow = (screen: string[]): number =>
  screen.findLastIndex((line) => line === PROMPT.trimEnd() || line.startsWith(PROMPT));
