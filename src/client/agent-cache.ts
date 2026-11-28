import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentInfo } from '../protocol/schema.js';

/*
 * The agents as this user's terminals last heard them from the daemon, kept
 * in $SHELLY_HOME, so `::` can say where a message goes the moment it opens,
 * before the daemon answers (a cold daemon takes a second or so). It holds
 * only agent ids, names and whether they can be used. Without it, the
 * config's default agent stands in.
 */

const CACHE_FILE = 'agents-cache.json';

const isAgentInfo = (value: unknown): value is AgentInfo => {
  const agent = value as Partial<AgentInfo> | null;
  return typeof agent === 'object' && agent !== null
    && typeof agent.id === 'string' && typeof agent.name === 'string'
    && typeof agent.available === 'boolean' && typeof agent.isDefault === 'boolean'
    && (agent.unavailableReason === null || typeof agent.unavailableReason === 'string')
    && typeof agent.supportsFast === 'boolean';
};

const readJson = (path: string): unknown => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
};

/**
 * The agents last seen, else the config's default agent alone (named by
 * `name`), else undefined. Never throws.
 */
export const readKnownAgents = (shellyHome: string, name: (agentId: string) => string): readonly AgentInfo[] | undefined => {
  const cached = readJson(join(shellyHome, CACHE_FILE)) as { agents?: unknown } | undefined;
  if (Array.isArray(cached?.agents) && cached.agents.every(isAgentInfo)) {
    return cached.agents;
  }
  const config = readJson(join(shellyHome, 'config.json')) as { defaultAgent?: unknown } | undefined;
  const id = typeof config?.defaultAgent === 'string' ? config.defaultAgent : undefined;
  return id ? [{ id, name: name(id), available: true, unavailableReason: null, supportsFast: false, isDefault: true }] : undefined;
};

/** What was last written, per file: an unchanged list is not written again. */
const written = new Map<string, string>();

/** Remember `agents` for the next `::` in any terminal. Best effort: a failure only costs the early hint. */
export const writeKnownAgents = (shellyHome: string, agents: readonly AgentInfo[]): void => {
  const path = join(shellyHome, CACHE_FILE);
  const text = `${JSON.stringify({ agents })}\n`;
  if (written.get(path) === text) {
    return;
  }
  try {
    if (readFileSync(path, 'utf8') === text) {
      written.set(path, text);
      return;
    }
  } catch {
    // Not there yet.
  }
  try {
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, text, { mode: 0o600 });
    renameSync(temporary, path);
    written.set(path, text);
  } catch {
    // $SHELLY_HOME not there or not writable: the hint just comes later.
  }
};
