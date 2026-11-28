import type { AgentInfo, AgentMode, ThreadSummary } from '../protocol/schema.js';
import { relativeTime, shortenPath, type PathContext } from './agent/format.js';
import { oneLine } from './agent/lines.js';
import type { PickerItem } from './list-picker.js';
import { BUILTIN_AGENT_NAMES } from '../protocol/agent-names.js';

/** `/threads`: title · agent · when · where, the current thread marked; running ones say so. */
export const threadPickerItems = (
  threads: readonly ThreadSummary[],
  options: PathContext & {
    readonly currentThreadId?: string;
    readonly now?: number;
    /** The name the user reads for an agent id (`Claude Code` for `claude`). */
    readonly agentName?: (agentId: string) => string;
  },
): PickerItem[] => {
  const now = options.now ?? Date.now();
  return [...threads]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((thread) => ({
      id: thread.id,
      label: oneLine(thread.title) || 'Untitled thread',
      columns: [
        options.agentName?.(thread.agentId) ?? thread.agentId,
        thread.status === 'running' ? '● working' : thread.status === 'waiting' ? '◆ waiting for you' : relativeTime(thread.updatedAt, now),
        thread.location === 'home' ? 'shelly home' : shortenPath(thread.cwd, options),
      ],
      keywords: `${thread.agentId} ${thread.cwd}`,
      current: thread.id === options.currentThreadId,
    }));
};

/**
 * `/agent`: each agent, the default marked, unavailable ones with the
 * reason, then the built-in agents the config turned off (the daemon lists
 * only those it may use), so the list is never empty.
 */
export const agentPickerItems = (agents: readonly AgentInfo[], options: { readonly currentAgentId?: string; readonly configPath?: string } = {}): PickerItem[] => [
  ...agents.map((agent) => ({
    id: agent.id,
    label: agent.name,
    columns: [agent.available ? (agent.isDefault ? 'default' : '') : (agent.unavailableReason ?? 'unavailable')],
    keywords: agent.id,
    current: agent.id === (options.currentAgentId ?? agents.find((candidate) => candidate.isDefault)?.id),
  })),
  ...Object.entries(BUILTIN_AGENT_NAMES)
    .filter(([id]) => !agents.some((agent) => agent.id === id))
    .map(([id, name]) => ({ id, label: name, columns: [`turned off in ${options.configPath ?? 'config.json'}`], keywords: id })),
];

/** Why a built-in agent missing from the daemon's list can't be used: the config turned it off. */
export const turnedOffReason = (name: string, configPath = "Shelly's config.json"): string =>
  `${name} is turned off in ${configPath} ("enabled": false).`;

/** `/mode`: the agent's modes with their descriptions, the current one marked. */
export const modePickerItems = (modes: readonly AgentMode[], currentModeId?: string): PickerItem[] =>
  modes.map((mode) => ({
    id: mode.id,
    label: mode.name,
    columns: mode.description ? [oneLine(mode.description)] : [],
    keywords: mode.id,
    current: mode.id === currentModeId,
  }));
