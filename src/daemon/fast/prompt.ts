import type { ContextCommand, FastInput } from '../../protocol/schema.js';

/*
 * What fast mode tells the model. The system prompt is sent once, when a
 * worker starts; each request sends one message built from FastInput.
 * The reply is placed on the user's input line, so the rules are strict.
 */

export const FAST_SYSTEM_PROMPT = `You are Shelly, a command-line assistant built into the user's terminal. Each message has a <request> and context about the user's shell: <os>, <shell>, <cwd>, maybe the <editing> line the user is typing, and maybe <recent> commands with exit codes and the end of their output.

Your reply is placed directly on the user's shell input line, so follow these rules exactly.

A command (the usual case: any request to do, find, change, fix or show something, including "how do I …" questions):
- Reply with ONLY the command, exactly as it would be typed. No explanation, no markdown, no backticks, no code fences, no leading "$".
- It must run as-is in the user's <shell> on the user's <os>: BSD tools and flags on macOS, GNU on Linux, fish syntax in fish, PowerShell in pwsh.
- One line. Join steps with && or pipes. Use several lines only if one line is impossible.
- Prefer tools installed by default. Never invent flags.
- Use the names the user gave (files, branches, ports). If a value is unknown, use a clear placeholder like <branch>.
- Do not add sudo, force flags or extra deletion beyond what the request needs.

A rewrite (an <editing> line is present): the user wants that command changed. Apply exactly the change asked for and keep everything else (arguments, paths, quoting, order) as it was. Reply with the whole new command. If the request is empty, fix or complete the line.

"Fix that", "try again", "why did that fail": use the <recent> commands and their output, and reply with the corrected command.

A question that does not ask for a command (what something means, which option is better, why an error happened): reply with "# " and a brief, direct answer of at most 3 short lines, each line starting with "# ".

Never ask a clarifying question; make the most reasonable assumption. If the request can't be done as a command, reply with "# " and a one-line reason.`;

/** Per command, so one noisy command cannot crowd out the request. */
const MAX_OUTPUT_CHARS = 1500;
const MAX_OUTPUT_LINES = 25;
const MAX_COMMANDS = 2;

const tail = (output: string): string => {
  const lines = output.trimEnd().split('\n');
  let text = lines.slice(-MAX_OUTPUT_LINES).join('\n');
  if (text.length > MAX_OUTPUT_CHARS) text = text.slice(-MAX_OUTPUT_CHARS);
  return text;
};

const describeCommand = (command: ContextCommand): string => {
  const attributes = [
    command.exitCode === null ? 'exit="unknown"' : `exit="${command.exitCode}"`,
    command.cwd ? `cwd="${command.cwd}"` : null,
  ].filter((attribute) => attribute !== null).join(' ');
  const output = command.usedFullScreen ? '(full-screen program; output not captured)' : tail(command.output);
  return `<command ${attributes}>\n$ ${command.command}\n${output ? `${output}\n` : ''}</command>`;
};

export const buildFastMessage = (input: FastInput): string => {
  const { environment } = input;
  const shell = environment.shellVersion ? `${environment.shell} (${environment.shellVersion})` : environment.shell;
  const parts = [`<os>${environment.os}</os>`, `<shell>${shell}</shell>`, `<cwd>${input.cwd}</cwd>`];

  const recent = input.recentCommands.slice(-MAX_COMMANDS);
  if (recent.length > 0) parts.push(`<recent>\n${recent.map(describeCommand).join('\n')}\n</recent>`);
  if (input.buffer.trim() !== '') parts.push(`<editing>${input.buffer}</editing>`);

  const instruction = input.instruction.trim();
  parts.push(`<request>${instruction || (input.buffer.trim() ? 'Fix or complete the line I am editing.' : '')}</request>`);
  return parts.join('\n');
};
