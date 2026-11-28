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
 * A line that looks like a command (`/word`, then a space or the end) but
 * names none: `/renmae typo` → `renmae`, with the command it most likely
 * meant. Undefined for a known command and for a line that only starts with
 * a slash (`/etc/hosts is empty?`).
 */
export const unknownSlashCommand = (
  line: string,
  commands: readonly SlashCommand[] = BUILTIN_COMMANDS,
): { readonly name: string; readonly suggestion: string | undefined } | undefined => {
  const match = /^\/([A-Za-z][\w-]*)(?:\s|$)/.exec(line.trim());
  if (!match || commands.some((command) => command.name === match[1])) {
    return undefined;
  }
  const name = match[1]!;
  const typed = name.toLowerCase();
  let best: { name: string; distance: number } | undefined;
  for (const command of commands) {
    const distance = command.name.startsWith(typed) ? 0 : editDistance(typed, command.name);
    if (distance <= Math.min(2, Math.floor(command.name.length / 2)) && (!best || distance < best.distance)) {
      best = { name: command.name, distance };
    }
  }
  return { name, suggestion: best?.name };
};

/** Edits (insert, delete, substitute, swap two neighbours) from `a` to `b`. */
const editDistance = (a: string, b: string): number => {
  const rows = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let value = Math.min(rows[i - 1]![j]! + 1, rows[i]![j - 1]! + 1, rows[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        value = Math.min(value, rows[i - 2]![j - 2]! + 1);
      }
      rows[i]![j] = value;
    }
  }
  return rows[a.length]![b.length]!;
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
