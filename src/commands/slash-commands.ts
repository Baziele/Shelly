export interface SlashCommand {
  /** Name without the leading slash. */
  readonly name: string;
  readonly description: string;
}

/**
 * Commands offered in the slash popup. These are placeholders until the agent
 * layer exists; skills discovered at runtime will be registered alongside them.
 */
export const BUILTIN_COMMANDS: readonly SlashCommand[] = [
  { name: 'ask', description: 'Ask a one-off question' },
  { name: 'run', description: 'Start a full agent run' },
  { name: 'skills', description: 'Browse skills Shelly can load' },
  { name: 'help', description: 'Show what Shelly can do' },
];

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
