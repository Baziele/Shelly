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

export const formatPromptForAgent = (context: PromptContext, userText: string): string => {
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
