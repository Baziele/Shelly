import type { CommandLog, CommandRecord } from './command-log.js';
import type { EnvironmentInfo } from './environment.js';

/*
 * What Shelly tells an agent about the session. Two shapes:
 *
 * - Ask (one quick question): the recent commands in full, in one go, since
 *   there is no second round trip to fetch more.
 * - Agent runs: a short list of recent commands, plus a tool the agent can
 *   call to read the output of the ones it cares about.
 */

export interface ContextCommand {
  readonly id: number;
  readonly command: string;
  readonly cwd: string | undefined;
  readonly exitCode: number | undefined;
  readonly durationMs: number;
  readonly usedFullScreen: boolean;
}

export interface AskCommand extends ContextCommand {
  /** The end of the output, where results and errors usually are. */
  readonly output: string;
  readonly omittedLines: number;
}

export interface AskContext {
  readonly environment: EnvironmentInfo;
  readonly cwd: string | undefined;
  readonly commands: readonly AskCommand[];
}

export interface AskContextOptions {
  readonly maxCommands?: number;
  /** Per command, so one noisy command cannot crowd out the rest. */
  readonly maxOutputChars?: number;
  /** Across all commands; the oldest give way first. */
  readonly maxTotalChars?: number;
}

export const buildAskContext = async (
  log: CommandLog,
  environment: EnvironmentInfo,
  { maxCommands = 10, maxOutputChars = 4000, maxTotalChars = 20_000 }: AskContextOptions = {},
): Promise<AskContext> => {
  const records = await log.recent(maxCommands);
  const commands: AskCommand[] = [];
  let budget = maxTotalChars;

  // Newest first, so the latest commands get their full share.
  for (const record of records.toReversed()) {
    const { text, omittedLines } = tailLines(record.output, Math.min(maxOutputChars, budget));
    budget = Math.max(0, budget - text.length);
    commands.unshift({ ...describe(record), output: text, omittedLines });
  }

  return { environment, cwd: log.cwd, commands };
};

export interface CommandSummary extends ContextCommand {
  readonly outputLines: number;
}

export interface OutputPage {
  readonly id: number;
  /** 1-based number of the first line returned. */
  readonly startLine: number;
  readonly lines: readonly string[];
  readonly totalLines: number;
}

export interface AgentContext {
  readonly environment: EnvironmentInfo;
  readonly cwd: string | undefined;
  readonly commands: readonly CommandSummary[];
  /** Backs the agent's read-command-output tool. Defaults to the last lines. */
  readOutput(id: number, page?: { startLine?: number; maxLines?: number }): Promise<OutputPage | undefined>;
}

export const buildAgentContext = async (
  log: CommandLog,
  environment: EnvironmentInfo,
  { maxCommands = 50 }: { maxCommands?: number } = {},
): Promise<AgentContext> => {
  const records = await log.recent(maxCommands);
  return {
    environment,
    cwd: log.cwd,
    commands: records.map((record) => ({ ...describe(record), outputLines: countLines(record.output) })),
    async readOutput(id, { startLine, maxLines = 200 } = {}) {
      const record = await log.find(id);
      if (!record) {
        return undefined;
      }
      const lines = record.output ? record.output.split('\n') : [];
      const first = Math.max(1, startLine ?? lines.length - maxLines + 1);
      return { id, startLine: first, lines: lines.slice(first - 1, first - 1 + maxLines), totalLines: lines.length };
    },
  };
};

/** Plain-text rendering of an ask context, for a model prompt or for showing the user. */
export const formatAskContext = (context: AskContext): string => {
  const { environment } = context;
  const lines = [
    `OS: ${environment.os}`,
    `Shell: ${environment.shellVersion ?? environment.shell}`,
    ...(environment.terminal ? [`Terminal: ${environment.terminal}`] : []),
    ...(context.cwd ? [`Working directory: ${context.cwd}`] : []),
    '',
  ];

  if (context.commands.length === 0) {
    lines.push('No commands run yet.');
  }

  for (const command of context.commands) {
    const status = command.exitCode === undefined ? 'exit status unknown' : `exit ${command.exitCode}`;
    lines.push(`$ ${command.command}`);
    lines.push(`  [${[status, formatDuration(command.durationMs), command.cwd].filter(Boolean).join(' · ')}]`);
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

  return lines.join('\n').trimEnd();
};

const describe = (record: CommandRecord): ContextCommand => ({
  id: record.id,
  command: record.command,
  cwd: record.cwd,
  exitCode: record.exitCode,
  durationMs: record.finishedAt - record.startedAt,
  usedFullScreen: record.usedFullScreen,
});

const countLines = (text: string): number => (text ? text.split('\n').length : 0);

/** The last whole lines of `text` that fit in `maxChars`. */
const tailLines = (text: string, maxChars: number): { text: string; omittedLines: number } => {
  if (text.length <= maxChars) {
    return { text, omittedLines: 0 };
  }
  const lines = text.split('\n');
  const kept: string[] = [];
  let size = 0;
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index] ?? '';
    if (size + line.length + 1 > maxChars) {
      break;
    }
    kept.unshift(line);
    size += line.length + 1;
  }
  return { text: kept.join('\n'), omittedLines: lines.length - kept.length };
};

const formatDuration = (ms: number): string => (ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`);
