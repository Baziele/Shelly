import { basename } from 'node:path';
import * as pty from 'node-pty';
import type { TerminalSize } from '../terminal/host-terminal.js';
import { ensurePtyHelperExecutable } from './pty-helper.js';

export interface ShellSessionOptions {
  readonly shell: string;
  readonly args?: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly size: TerminalSize;
}

/** Processes that count as "the shell is at a prompt" when they own the terminal. */
const KNOWN_SHELLS = new Set(['bash', 'dash', 'fish', 'ksh', 'nu', 'pwsh', 'sh', 'tcsh', 'zsh']);

export const defaultShell = (): string => process.platform === 'win32'
  ? process.env.ComSpec ?? 'powershell.exe'
  : process.env.SHELL ?? '/bin/sh';

const processName = (path: string): string => basename(path).replace(/^-/, '').replace(/\.exe$/i, '');

/** The user's shell, running in a pseudo-terminal that Shelly sits in front of. */
export class ShellSession {
  private constructor(
    private readonly terminal: pty.IPty,
    private readonly shellName: string,
  ) {}

  static spawn(options: ShellSessionOptions): ShellSession {
    ensurePtyHelperExecutable();
    const env = Object.fromEntries(
      Object.entries(options.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
    );

    const terminal = pty.spawn(options.shell, [...(options.args ?? [])], {
      name: env.TERM ?? 'xterm-256color',
      cols: options.size.cols,
      rows: options.size.rows,
      cwd: options.cwd,
      env,
    });

    return new ShellSession(terminal, processName(options.shell));
  }

  onData(listener: (data: string) => void): void {
    this.terminal.onData(listener);
  }

  onExit(listener: (exitCode: number) => void): void {
    this.terminal.onExit(({ exitCode }) => listener(exitCode));
  }

  write(data: string): void {
    this.terminal.write(data);
  }

  resize(size: TerminalSize): void {
    this.terminal.resize(size.cols, size.rows);
  }

  kill(): void {
    this.terminal.kill();
  }

  /**
   * True when the shell itself (not vim, less, a REPL, ssh…) owns the
   * terminal. Windows does not report the foreground process, so assume yes.
   */
  isShellInForeground(): boolean {
    if (process.platform === 'win32') {
      return true;
    }

    const foreground = processName(this.terminal.process);
    return foreground === this.shellName || KNOWN_SHELLS.has(foreground);
  }
}
