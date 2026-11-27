export interface SlashCommand {
  /** Name without the leading slash. */
  readonly name: string;
  readonly description: string;
}

/** The commands of the `::` input, in the order the slash popup lists them. */
export const BUILTIN_COMMANDS: readonly SlashCommand[] = [
  { name: 'new', description: 'Start a fresh thread with your next message' },
  { name: 'here', description: 'Start the next thread in this folder' },
  { name: 'threads', description: 'Switch to another thread' },
  { name: 'agent', description: 'Choose the agent for new threads' },
  { name: 'mode', description: "Change the thread's mode" },
  { name: 'rename', description: 'Rename this thread: /rename <title>' },
  { name: 'context', description: 'Show what the agent is told about your shell' },
  { name: 'help', description: 'Commands and keys' },
];

/**
 * The command a submitted line runs: `/rename Fix it` → `rename` and
 * `Fix it`. Undefined when the line does not start with a known command, so
 * a question that merely starts with a slash (`/etc/hosts is empty?`) goes
 * to the agent.
 */
export const parseSlashCommand = (
  line: string,
  commands: readonly SlashCommand[] = BUILTIN_COMMANDS,
): { readonly name: string; readonly args: string } | undefined => {
  const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(line.trim());
  if (!match || !commands.some((command) => command.name === match[1])) {
    return undefined;
  }
  return { name: match[1]!, args: (match[2] ?? '').trim() };
};

/**
 * The command name being typed, or undefined when the input is not a bare
 * slash command: `/ru` → `ru`, `/` → ``, `/run tests` → undefined.
 */
export const parseSlashQuery = (input: string): string | undefined => {
  const match = /^\/(\S*)$/.exec(input);
  return match ? match[1] : undefined;
};

export class CommandRegistry {
  constructor(private readonly commands: readonly SlashCommand[]) {}

  /** Commands whose name starts with `query`, followed by those that merely contain it. */
  match(query: string): SlashCommand[] {
    const needle = query.toLowerCase();
    const prefixMatches: SlashCommand[] = [];
    const otherMatches: SlashCommand[] = [];

    for (const command of this.commands) {
      const name = command.name.toLowerCase();
      if (name.startsWith(needle)) {
        prefixMatches.push(command);
      } else if (name.includes(needle)) {
        otherMatches.push(command);
      }
    }

    return [...prefixMatches, ...otherMatches];
  }
}
