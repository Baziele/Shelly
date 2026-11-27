import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import xterm from '@xterm/headless';
import * as pty from 'node-pty';
import { flush, screenLines, writeScreenshot, type ScreenshotFiles, type ScreenshotOptions } from './screen.js';
import { useModernWidths } from './unicode.js';

/*
 * Drives Shelly in a real pseudo-terminal, attached to an emulated terminal
 * (xterm.js) that answers cursor position reports and device attribute
 * queries like a real one. Each run gets a throwaway HOME and SHELLY_HOME,
 * whose startup files give the shell a plain `$ ` prompt, so results never
 * depend on (or touch) the user's own setup.
 */

const ENTRY = fileURLToPath(new URL('../../src/index.ts', import.meta.url));
// Resolved here, since Shelly may be started from a directory that cannot see this project's packages.
const TSX = import.meta.resolve('tsx');

export const PROMPT = '$ ';

/** Startup files that give each shell a `$ ` prompt. */
export const PROMPT_FILES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  zsh: { '.zshrc': "PS1='$ '\n" },
  bash: { '.bashrc': "PS1='$ '\n" },
  fish: { '.config/fish/config.fish': "function fish_prompt; echo -n '$ '; end\nfunction fish_greeting; end\n" },
};

export const defaultShell = (): string =>
  ['/bin/zsh', '/bin/bash'].find((shell) => existsSync(shell)) ?? '/bin/sh';

export interface DriverOptions {
  /** Path to zsh, bash, fish or sh. Default: /bin/zsh if present. */
  readonly shell?: string;
  readonly cols?: number;
  readonly rows?: number;
  /** Added to (and overriding) the clean environment Shelly starts with. */
  readonly env?: Readonly<Record<string, string>>;
  /** Use this HOME instead of a throwaway one. It is neither populated nor removed. */
  readonly home?: string;
  /** Files written into the throwaway HOME. Default: `PROMPT_FILES` for the shell. */
  readonly files?: Readonly<Record<string, string>>;
  /** Working directory. Default: HOME. */
  readonly cwd?: string;
  /** Where `screenshot` writes. Default: a new directory under the system temp dir. */
  readonly outDir?: string;
  /** Wait for a `$ ` prompt before returning. Default true. */
  readonly waitForPrompt?: boolean;
  /** Run this instead of Shelly (argv; the first entry is the program). */
  readonly command?: readonly string[];
  /** Passed to every screenshot. */
  readonly screenshot?: ScreenshotOptions;
}

export interface WaitOptions {
  /** Default 5000. */
  readonly timeoutMs?: number;
  /** Search the scrollback too. */
  readonly scrollback?: boolean;
}

export interface Step {
  readonly index: number;
  readonly name: string;
  readonly files: ScreenshotFiles;
  readonly text: string;
}

/** Named keys for `press`; also `ctrl-<letter>` and `alt-<char>`. */
export const KEYS: Readonly<Record<string, string>> = {
  enter: '\r',
  return: '\r',
  esc: '\u001b',
  escape: '\u001b',
  tab: '\t',
  'shift-tab': '\u001b[Z',
  backspace: '\u007f',
  delete: '\u001b[3~',
  space: ' ',
  home: '\u001b[H',
  end: '\u001b[F',
  pageup: '\u001b[5~',
  pagedown: '\u001b[6~',
};
const ARROWS: Readonly<Record<string, string>> = { up: 'A', down: 'B', right: 'C', left: 'D' };

export class ScenarioDriver {
  readonly terminal: xterm.Terminal;
  readonly home: string;
  readonly shellyHome: string;
  readonly shell: string;
  readonly steps: Step[] = [];
  private readonly child: pty.IPty;
  private readonly tempDirs: string[] = [];
  private readonly exitCode: Promise<number>;
  private outDirPath: string | undefined;
  private rawOutput = '';
  private lastOutputAt = Date.now();
  private exited = false;
  private closing: Promise<number> | undefined;

  private constructor(private readonly options: DriverOptions) {
    this.shell = options.shell ?? defaultShell();
    const cols = options.cols ?? 100;
    const rows = options.rows ?? 30;

    if (options.home) {
      this.home = options.home;
    } else {
      this.home = this.tempDir('shelly-home-');
      const files = options.files ?? PROMPT_FILES[basename(this.shell)] ?? {};
      for (const [file, content] of Object.entries(files)) {
        mkdirSync(dirname(join(this.home, file)), { recursive: true });
        writeFileSync(join(this.home, file), content);
      }
    }
    this.shellyHome = options.env?.SHELLY_HOME ?? this.tempDir('shelly-state-');
    this.outDirPath = options.outDir;

    this.terminal = new xterm.Terminal({ cols, rows, allowProposedApi: true, scrollback: 1000 });
    useModernWidths(this.terminal);
    const [program, ...args] = options.command ?? [process.execPath, '--experimental-ffi', '--no-warnings', '--import', TSX, ENTRY];
    this.child = pty.spawn(program!, args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: options.cwd ?? this.home,
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        HOME: this.home,
        SHELLY_HOME: this.shellyHome,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        // A UTF-8 locale that exists: Linux images often lack en_US.UTF-8.
        LANG: process.platform === 'darwin' ? 'en_US.UTF-8' : 'C.UTF-8',
        SHELL: this.shell,
        PS1: PROMPT,
        // macOS's bash 3.2 otherwise opens with a notice about zsh.
        BASH_SILENCE_DEPRECATION_WARNING: '1',
        ...options.env,
      },
    });
    this.exitCode = new Promise((resolve) => this.child.onExit(({ exitCode }) => {
      this.exited = true;
      resolve(exitCode);
    }));
    this.child.onData((data) => {
      this.rawOutput += data;
      this.lastOutputAt = Date.now();
      this.terminal.write(data);
    });
    // Replies to the application's queries (cursor position, device attributes) go back to it.
    this.terminal.onData((reply) => {
      if (!this.exited) {
        this.child.write(reply);
      }
    });
  }

  /** Starts Shelly and, unless told otherwise, waits for the shell prompt. */
  static async start(options: DriverOptions = {}): Promise<ScenarioDriver> {
    const driver = new ScenarioDriver(options);
    if (options.waitForPrompt ?? true) {
      try {
        await driver.waitFor((lines) => lastPromptRow(lines) >= 0, 'the shell prompt', { timeoutMs: 10_000 });
      } catch (error) {
        await driver.close();
        throw error;
      }
    }
    return driver;
  }

  get pid(): number {
    return this.child.pid;
  }

  /** The directory screenshots go to (created on first use). */
  get outDir(): string {
    this.outDirPath ??= mkdtempSync(join(tmpdir(), 'shelly-scenario-'));
    mkdirSync(this.outDirPath, { recursive: true });
    return this.outDirPath;
  }

  /** Types text. Escape sequences in it are sent whole, everything else one character at a time. */
  async type(text: string, { perCharDelayMs = 15 }: { perCharDelayMs?: number } = {}): Promise<void> {
    if (perCharDelayMs <= 0) {
      this.child.write(text);
      return;
    }
    for (const key of text.match(/\u001b\[[0-9;?]*[ -/]*[@-~]|\u001bO.|\u001b.|[\s\S]/gu) ?? []) {
      this.child.write(key);
      await sleep(perCharDelayMs);
    }
  }

  /** Presses a named key: enter, esc, tab, backspace, up, down, left, right, ctrl-c, ctrl-<letter>, alt-<char>… */
  async press(key: string, times = 1): Promise<void> {
    const sequence = keySequence(key, this.terminal.modes.applicationCursorKeysMode);
    for (let i = 0; i < times; i++) {
      this.child.write(sequence);
      await sleep(15);
    }
  }

  /** The visible screen (or everything, with `scrollback`) as text, trailing spaces trimmed. */
  async screen(options: { scrollback?: boolean; cursor?: boolean } = {}): Promise<string> {
    return (await this.lines(options)).join('\n');
  }

  async lines(options: { scrollback?: boolean; cursor?: boolean } = {}): Promise<string[]> {
    await flush(this.terminal);
    return screenLines(this.terminal, { cursor: false, ...options });
  }

  /** 1-based cursor position on the visible screen. */
  async cursor(): Promise<{ row: number; col: number }> {
    await flush(this.terminal);
    const buffer = this.terminal.buffer.active;
    return { row: buffer.cursorY + 1, col: buffer.cursorX + 1 };
  }

  /** Everything the application wrote to the terminal so far. */
  raw(): string {
    return this.rawOutput;
  }

  /** Polls the screen until `predicate` holds; fails with the last screen (and a screenshot, when there is an outDir). */
  async waitFor(predicate: (lines: string[]) => boolean, description: string, options: WaitOptions = {}): Promise<string[]> {
    const deadline = Date.now() + (options.timeoutMs ?? 5000);
    let lines: string[] = [];
    for (;;) {
      lines = await this.lines({ scrollback: options.scrollback });
      if (predicate(lines)) {
        return lines;
      }
      if (this.exited || Date.now() > deadline) {
        break;
      }
      await sleep(25);
    }
    let shot = '';
    if (this.outDirPath) {
      const step = await this.screenshot(`timeout-${description.replace(/[^a-z0-9]+/gi, '-').slice(0, 40)}`);
      shot = `\nScreenshot: ${step.files.png ?? step.files.svg}`;
    }
    throw new Error(`${this.exited ? 'Exited' : 'Timed out'} waiting for ${description}. Screen:\n${lines.join('\n')}${shot}`);
  }

  /** Waits until the screen contains `pattern`; returns the screen text. */
  async waitForText(pattern: string | RegExp, options: WaitOptions = {}): Promise<string> {
    const matches = (text: string): boolean => (typeof pattern === 'string' ? text.includes(pattern) : pattern.test(text));
    const lines = await this.waitFor((rows) => matches(rows.join('\n')), `text ${String(pattern)}`, options);
    return lines.join('\n');
  }

  /** Waits until the application has written nothing for `quietMs` (default 300). */
  async waitForStable({ quietMs = 300, timeoutMs = 10_000 }: { quietMs?: number; timeoutMs?: number } = {}): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() - this.lastOutputAt < quietMs) {
      if (Date.now() > deadline) {
        throw new Error(`Output did not settle for ${quietMs}ms within ${timeoutMs}ms`);
      }
      await sleep(Math.min(50, quietMs - (Date.now() - this.lastOutputAt) + 1));
    }
    await flush(this.terminal);
  }

  /** Writes `<outDir>/<NN>-<name>.png` and `.txt` and records the step. */
  async screenshot(name: string, options: ScreenshotOptions = {}): Promise<Step> {
    const index = this.steps.length + 1;
    const safe = name.replace(/[^\w.-]+/g, '-');
    const base = join(this.outDir, `${String(index).padStart(2, '0')}-${safe}`);
    const files = await writeScreenshot(this.terminal, base, { ...this.options.screenshot, ...options });
    const step: Step = { index, name, files, text: screenLines(this.terminal, { cursor: false }).join('\n') };
    this.steps.push(step);
    return step;
  }

  async resize(cols: number, rows: number): Promise<void> {
    this.child.resize(cols, rows);
    this.terminal.resize(cols, rows);
    await flush(this.terminal);
  }

  /** Whether the application has exited. */
  get hasExited(): boolean {
    return this.exited;
  }

  /**
   * Closes Shelly (Ctrl+C, then `exit`; killed if still running after 3 s),
   * removes the throwaway directories and returns the exit code (-1 if killed).
   */
  close(): Promise<number> {
    this.closing ??= (async () => {
      // Keys typed just before (say `exit 3`) may still be on their way; let them land first.
      await Promise.race([this.exitCode, sleep(100)]);
      if (!this.exited) {
        try {
          // Ctrl+C first, in case Shelly's input is still open.
          this.child.write('\u0003');
          await sleep(100);
          this.child.write('exit\r');
        } catch {
          // Already gone.
        }
      }
      const code = await Promise.race([this.exitCode, sleep(3000).then(() => -1)]);
      if (code === -1) {
        this.child.kill();
        await Promise.race([this.exitCode, sleep(1000)]);
      }
      this.terminal.dispose();
      for (const dir of this.tempDirs) {
        rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
      return code;
    })();
    return this.closing;
  }

  /** Waits for the application to exit by itself; returns its exit code. */
  async waitForExit({ timeoutMs = 5000 }: { timeoutMs?: number } = {}): Promise<number> {
    const code = await Promise.race([this.exitCode, sleep(timeoutMs).then(() => undefined)]);
    if (code === undefined) {
      throw new Error(`Did not exit within ${timeoutMs}ms`);
    }
    return code;
  }

  private tempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    this.tempDirs.push(dir);
    return dir;
  }
}

export const startScenario = (options: DriverOptions = {}): Promise<ScenarioDriver> => ScenarioDriver.start(options);

export const keySequence = (key: string, applicationCursorKeys = false): string => {
  const name = key.toLowerCase();
  const named = KEYS[name];
  if (named) {
    return named;
  }
  const arrow = ARROWS[name];
  if (arrow) {
    return `\u001b${applicationCursorKeys ? 'O' : '['}${arrow}`;
  }
  const ctrl = /^ctrl-([a-z@[\\\]^_])$/.exec(name);
  if (ctrl) {
    return String.fromCharCode(ctrl[1]!.toUpperCase().charCodeAt(0) & 0x1f);
  }
  const alt = /^alt-(.)$/su.exec(key);
  if (alt) {
    return `\u001b${alt[1]}`;
  }
  throw new Error(`Unknown key "${key}". Use type() for text.`);
};

/** Index of the last row showing the `$ ` prompt (rows are trimmed, so an empty prompt is just `$`). */
export const lastPromptRow = (lines: string[]): number =>
  lines.findLastIndex((line) => line === PROMPT.trimEnd() || line.startsWith(PROMPT));
