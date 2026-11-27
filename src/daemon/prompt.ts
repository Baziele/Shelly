import { formatCommandLines, formatEnvironmentLines } from '../context/format-context.js';
import type { PromptContext } from '../protocol/schema.js';

/*
 * The text an agent receives for one turn: a short note on where the request
 * comes from, the session context, then the user's request, delimited so the
 * agent never mistakes command output for instructions. The client has
 * already budgeted and redacted the outputs; this only lays them out.
 */

const PREAMBLE =
  'The user is speaking to you from their terminal through Shelly. ' +
  'Below is their terminal session: the environment, the shell\'s current directory, ' +
  'and the commands run since you last heard from them, with exit codes and the end of each output.';

/**
 * Anything that could read as the block's own tag, opening or closing, in
 * any case and spacing (`</shelly_context>`, `< / SHELLY_CONTEXT >`,
 * `</shelly-context>`). Command output is arbitrary text: a file that
 * contains the closing tag, or a heredoc with it at column 0, would end the
 * block early and make what follows read as the user's own request.
 */
const TAG_LIKE = /<(?=[\s/]*shelly[\W_]*context)/giu;

/** Defuse the block's tag in text from the session, keeping it readable. */
export const neutraliseContextTags = (text: string): string => text.replace(TAG_LIKE, '&lt;');

/** The context with its text defused; everything else, including fields added later, is kept as it is. */
export const neutraliseContext = (context: PromptContext): PromptContext => {
  const clean = (text: string | null): string | null => (text === null ? null : neutraliseContextTags(text));
  return {
    ...context,
    cwd: neutraliseContextTags(context.cwd),
    environment: {
      ...context.environment,
      os: neutraliseContextTags(context.environment.os),
      shell: neutraliseContextTags(context.environment.shell),
      shellVersion: clean(context.environment.shellVersion),
      terminal: clean(context.environment.terminal),
    },
    commands: context.commands.map((command) => ({
      ...command,
      command: neutraliseContextTags(command.command),
      cwd: clean(command.cwd),
      output: neutraliseContextTags(command.output),
    })),
  };
};

export const formatPromptForAgent = (rawContext: PromptContext, userText: string): string => {
  // Everything inside the block comes from the session; none of it may close the block.
  const context = neutraliseContext(rawContext);
  const lines = [
    '<shelly_context>',
    PREAMBLE,
    '',
    ...formatEnvironmentLines(context.environment, context.cwd),
    '',
  ];
  if (context.commands.length === 0) {
    lines.push('No new commands since the last message.', '');
  } else {
    lines.push('Recent commands, oldest first:', '', ...formatCommandLines(context.commands));
  }
  while (lines.at(-1) === '') {
    lines.pop();
  }
  lines.push('</shelly_context>', '', userText.trim());
  return lines.join('\n');
};
