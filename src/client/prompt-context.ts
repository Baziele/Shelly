import type { CommandLog } from '../context/command-log.js';
import type { EnvironmentInfo } from '../context/environment.js';
import { buildAskContext, type AskCommand } from '../context/session-context.js';
import type {
  ContextCommand,
  EnvironmentInfo as ProtocolEnvironment,
  FastInput,
  PromptContext,
} from '../protocol/schema.js';

/*
 * What the client tells the daemon about the shell with each request. The
 * command log has already cut and redacted the outputs; this picks which
 * commands go and puts them in the protocol's shape.
 */

/** Fast mode's budget: the last command or two, kept short so the request stays quick. */
const FAST_COMMANDS = 2;
const FAST_OUTPUT_CHARS = 2000;

export const toProtocolEnvironment = (environment: EnvironmentInfo): ProtocolEnvironment => ({
  os: environment.os,
  shell: environment.shell,
  shellVersion: environment.shellVersion ?? null,
  terminal: environment.terminal ?? null,
});

const toProtocolCommand = (command: AskCommand): ContextCommand => ({
  id: command.id,
  command: command.command,
  cwd: command.cwd ?? null,
  exitCode: command.exitCode ?? null,
  durationMs: command.durationMs,
  output: command.output,
  omittedLines: command.omittedLines,
  usedFullScreen: command.usedFullScreen,
});

/**
 * The context for an agent turn. `afterCommandId` is the newest command the
 * thread has already heard about from this terminal: undefined for the first
 * message, which gets the recent commands in full within the budget; later
 * messages get only what ran since.
 */
export const buildPromptContext = async (
  log: CommandLog,
  environment: EnvironmentInfo,
  cwd: string,
  afterCommandId: number | undefined,
): Promise<PromptContext> => {
  const context = await buildAskContext(log, environment);
  const commands = context.commands.filter((command) => afterCommandId === undefined || command.id > afterCommandId);
  return { cwd, environment: toProtocolEnvironment(environment), commands: commands.map(toProtocolCommand) };
};

/** The newest command id in a context, to remember what the thread has heard. */
export const newestCommandId = (context: PromptContext, previous: number | undefined): number | undefined =>
  context.commands.reduce<number | undefined>((newest, command) => Math.max(newest ?? command.id, command.id), previous);

export const buildFastInput = async (
  log: CommandLog,
  environment: EnvironmentInfo,
  cwd: string,
  instruction: string,
  buffer: string,
): Promise<FastInput> => {
  const context = await buildAskContext(log, environment, {
    maxCommands: FAST_COMMANDS,
    maxOutputChars: FAST_OUTPUT_CHARS,
    maxTotalChars: FAST_OUTPUT_CHARS * FAST_COMMANDS,
  });
  return {
    instruction,
    buffer,
    cwd,
    environment: toProtocolEnvironment(environment),
    recentCommands: context.commands.map(toProtocolCommand),
  };
};
