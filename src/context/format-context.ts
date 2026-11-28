/*
 * Plain-text rendering of the session context: the environment, the shell's
 * directory and the recent commands with their output tails. Shared by the
 * client (ask context) and the daemon (the text an agent receives), so both
 * describe a session the same way. No imports: the daemon and the client's
 * startup path can both load it.
 */

export interface FormatEnvironment {
  readonly os: string;
  readonly shell: string;
  readonly shellVersion?: string | null | undefined;
  readonly terminal?: string | null | undefined;
}

export interface FormatCommand {
  readonly command: string;
  readonly cwd?: string | null | undefined;
  readonly exitCode?: number | null | undefined;
  readonly durationMs: number;
  readonly output: string;
  readonly omittedLines: number;
  readonly usedFullScreen: boolean;
}

export const formatEnvironmentLines = (
  environment: FormatEnvironment,
  cwd: string | null | undefined,
): string[] => [
  `OS: ${environment.os}`,
  `Shell: ${environment.shellVersion ?? environment.shell}`,
  ...(environment.terminal ? [`Terminal: ${environment.terminal}`] : []),
  ...(cwd ? [`Working directory: ${cwd}`] : []),
];

/**
 * One block per command, each followed by a blank line. A command's
 * directory is given with the first command and then only when it changes.
 */
export const formatCommandLines = (commands: readonly FormatCommand[]): string[] => {
  const lines: string[] = [];
  let lastCwd: string | null | undefined;
  for (const command of commands) {
    const status = command.exitCode === undefined || command.exitCode === null
      ? 'exit status unknown'
      : `exit ${command.exitCode}`;
    const cwd = command.cwd && command.cwd !== lastCwd ? command.cwd : undefined;
    lastCwd = command.cwd ?? lastCwd;
    lines.push(`$ ${command.command}`);
    lines.push(`  [${[status, formatDuration(command.durationMs), cwd].filter(Boolean).join(' · ')}]`);
    if (command.omittedLines > 0) {
      lines.push(`  [… ${command.omittedLines} earlier lines omitted]`);
    }
    if (command.output) {
      lines.push(...command.output.split('\n').map((line) => `  ${line}`));
    } else if (command.usedFullScreen) {
      lines.push('  [full-screen program; its screen is not recorded]');
    }
    lines.push('');
  }
  return lines;
};

export const formatDuration = (ms: number): string => (ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`);
