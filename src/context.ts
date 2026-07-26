import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { readlinkSync } from 'node:fs';

/** Details about the environment in which Shelly is running. */
export interface Context {
  OS: string;
  Shell: string;
  ShellVersion: string;
  WorkingDirectory: string;
  PythonVersion: string;
  NodeVersion: string;
}

/**
 * Return the PID of the shell (or other process) that launched Shelly.
 *
 * Node exposes this directly and consistently on Windows, macOS, and Linux;
 * unlike `process.pid`, it identifies the process whose terminal context we
 * want to inspect.
 */
export function getpid(): number {
  return process.ppid || process.pid;
}

const getShell = (): string => {
  if (process.platform === 'win32') {
    return process.env.ComSpec ?? process.env.COMSPEC ?? 'powershell.exe';
  }

  return process.env.SHELL ?? 'sh';
};

const getShellVersion = (shellPath: string): string => {
  try {
    const lowerCaseShell = shellPath.toLowerCase();

    if (lowerCaseShell.endsWith('cmd.exe') || lowerCaseShell === 'cmd') {
      return execFileSync(shellPath, ['/d', '/s', '/c', 'ver'], {
        encoding: 'utf8',
      }).trim();
    }

    if (lowerCaseShell.includes('powershell') || lowerCaseShell.includes('pwsh')) {
      return execFileSync(shellPath, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()'], {
        encoding: 'utf8',
      }).trim();
    }

    return execFileSync(shellPath, ['--version'], { encoding: 'utf8' }).trim();
  } catch {
    return 'Could not detect shell version.';
  }
};

/**
 * Get a process's working directory. Linux exposes it through procfs and
 * macOS exposes it through `lsof`. Windows does not provide another process's
 * cwd through Node or a standard command, so use Shelly's inherited cwd,
 * which is the launching shell's cwd when Shelly starts.
 */
export const getWorkingDirectory = (pid: number): string => {
  if (pid === process.pid) {
    return process.cwd();
  }

  try {
    if (process.platform === 'linux') {
      return readlinkSync(`/proc/${pid}/cwd`);
    }

    if (process.platform === 'darwin') {
      const output = execFileSync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], {
        encoding: 'utf8',
      });
      const cwd = output.split(/\r?\n/).find((line) => line.startsWith('n'));

      if (cwd) {
        return cwd.slice(1);
      }
    }
  } catch {
    // Fall through to the inherited directory below.
  }

  return process.cwd();
};

const getPythonVersion = (): string => {
  const candidates: ReadonlyArray<readonly [command: string, args: readonly string[]]> = process.platform === 'win32'
    ? [['py', ['-3', '--version']], ['python', ['--version']]]
    : [['python3', ['--version']], ['python', ['--version']]];

  for (const [command, args] of candidates) {
    try {
      return execFileSync(command, args, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
    } catch {
      // Try the next conventional Python executable name.
    }
  }

  return 'Could not detect Python version.';
};

/** Assemble a portable snapshot of Shelly's runtime environment. */
export function createContext(): Context {
  const shell = getShell();
  const pid = getpid();

  return {
    OS: `${os.type()} ${os.release()} (${os.arch()})`,
    Shell: shell,
    ShellVersion: getShellVersion(shell),
    WorkingDirectory: getWorkingDirectory(pid),
    PythonVersion: getPythonVersion(),
    NodeVersion: process.version,
  };
}
