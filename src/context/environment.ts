import { execFile } from 'node:child_process';
import os from 'node:os';
import { basename } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** Facts about the machine and shell that rarely change during a session. */
export interface EnvironmentInfo {
  readonly os: string;
  readonly shell: string;
  readonly shellVersion: string | undefined;
  /** The terminal app, when it says (TERM_PROGRAM). */
  readonly terminal: string | undefined;
}

const OS_NAMES: Partial<Record<NodeJS.Platform, string>> = { darwin: 'macOS', linux: 'Linux', win32: 'Windows' };

/** Ask the shell for its version; quick, but still run off the startup path. */
const shellVersion = async (shell: string): Promise<string | undefined> => {
  const name = basename(shell).toLowerCase();
  const args = name.startsWith('pwsh') || name.startsWith('powershell')
    ? ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()']
    : name === 'cmd.exe' || name === 'cmd'
      ? ['/d', '/c', 'ver']
      : ['--version'];

  try {
    const { stdout } = await run(shell, args, { timeout: 2000, encoding: 'utf8' });
    return stdout.trim().split('\n')[0]?.trim() || undefined;
  } catch {
    return undefined;
  }
};

export const describeEnvironment = async (shell: string, env: NodeJS.ProcessEnv): Promise<EnvironmentInfo> => ({
  os: `${OS_NAMES[process.platform] ?? process.platform} ${os.release()} (${os.arch()})`,
  shell: basename(shell),
  shellVersion: await shellVersion(shell),
  terminal: env.TERM_PROGRAM,
});
