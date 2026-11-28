/*
 * The names users read for the built-in agents. The daemon reports every
 * agent's name (a configured `name` wins); the client falls back to these
 * before it has heard from the daemon, and to the id for any other agent.
 * No imports: the client's startup path loads it.
 */

export const BUILTIN_AGENT_NAMES: Readonly<Record<string, string>> = {
  claude: 'Claude Code',
  opencode: 'OpenCode',
};

/** The name to show for an agent known only by its id. */
export const fallbackAgentName = (agentId: string): string => BUILTIN_AGENT_NAMES[agentId] ?? agentId;
