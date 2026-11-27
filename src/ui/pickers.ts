import type { AgentInfo, AgentMode, ThreadSummary } from '../protocol/schema.js';
import { relativeTime, shortenPath, type PathContext } from './agent/format.js';
import { oneLine } from './agent/lines.js';
import type { PickerItem } from './list-picker.js';

/** `/threads`: title · agent · when · where, the current thread marked; running ones say so. */
export const threadPickerItems = (
  threads: readonly ThreadSummary[],
  options: PathContext & { readonly currentThreadId?: string; readonly now?: number },
): PickerItem[] => {
  const now = options.now ?? Date.now();
  return [...threads]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((thread) => ({
      id: thread.id,
      label: oneLine(thread.title) || 'Untitled thread',
      columns: [
        thread.agentId,
        thread.status === 'running' ? '● working' : thread.status === 'waiting' ? '◆ waiting for you' : relativeTime(thread.updatedAt, now),
        thread.location === 'home' ? 'shelly home' : shortenPath(thread.cwd, options),
      ],
      keywords: `${thread.agentId} ${thread.cwd}`,
      current: thread.id === options.currentThreadId,
    }));
};

/** `/agent`: each agent, the default marked, unavailable ones with the reason. */
export const agentPickerItems = (agents: readonly AgentInfo[], currentAgentId?: string): PickerItem[] =>
  agents.map((agent) => ({
    id: agent.id,
    label: agent.name,
    columns: [agent.available ? (agent.isDefault ? 'default' : '') : (agent.unavailableReason ?? 'unavailable')],
    keywords: agent.id,
    current: agent.id === (currentAgentId ?? agents.find((candidate) => candidate.isDefault)?.id),
  }));

/** `/mode`: the agent's modes with their descriptions, the current one marked. */
export const modePickerItems = (modes: readonly AgentMode[], currentModeId?: string): PickerItem[] =>
  modes.map((mode) => ({
    id: mode.id,
    label: mode.name,
    columns: mode.description ? [oneLine(mode.description)] : [],
    keywords: mode.id,
    current: mode.id === currentModeId,
  }));
