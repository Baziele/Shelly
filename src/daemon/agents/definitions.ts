import { accessSync, constants, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import { BUILTIN_AGENT_NAMES } from '../../protocol/agent-names.js';
import type { AgentInfo } from '../../protocol/schema.js';
import { findClaudeExecutable, withoutHostSession } from '../claude-env.js';
import type { AgentSettings, ConfigFile } from '../services.js';

/*
 * The agents Shelly knows: the built-in Claude Code and OpenCode, and custom
 * ACP agents from config.json. Everything agent-specific lives here, as data
 * the runtime reads (quirks, messages, timeouts); the runtime itself never
 * compares agent ids.
 */

export type BuiltinAgentId = 'claude' | 'opencode';

export interface AgentDefinition {
  readonly id: string;
  readonly name: string;
  readonly enabled: boolean;
  /** How to start the ACP server; `unavailable` says why it can't be. */
  readonly launch:
    | { readonly ok: true; readonly command: string; readonly args: readonly string[] }
    | { readonly ok: false; readonly reason: string };
  /** Overrides on top of the cleaned daemon env. */
  readonly env: Readonly<Record<string, string>>;
  /**
   * Set on every session this agent opens: ACP `_meta` on session/new and
   * resume, and config options set once the session is open. Carries the
   * configured `model`.
   */
  readonly sessionSetup: SessionSetup;
  readonly supportsFast: boolean;
  /** An agent process with no sessions exits after this long. */
  readonly processIdleMs: number;
  /** A session with no turn is closed after this long. */
  readonly sessionIdleMs: number;
  /** Shown when a prompt fails with ACP authRequired. */
  readonly signInMessage: string;
  readonly quirks: {
    /**
     * Rejecting a permission ends the whole turn with stopReason `cancelled`
     * (OpenCode). Shelly reports that turn as ended normally, with a notice.
     */
    readonly rejectEndsTurnCancelled: boolean;
    /**
     * `session/resume` on a session that is already open replaces it in place
     * with the new parameters (claude-agent-acp), so changing directories
     * needs no `session/close` first.
     */
    readonly resumeReplacesLiveSession: boolean;
  };
}

export interface SessionSetup {
  readonly meta?: Readonly<Record<string, unknown>>;
  readonly configOptions?: Readonly<Record<string, string>>;
}

/** The model as an ACP config option, which agents that list models (OpenCode, the fake agent) accept. */
const modelSetup = (model: string | undefined): SessionSetup =>
  model === undefined || model.trim() === '' ? {} : { configOptions: { model: model.trim() } };

const MINUTE = 60_000;

const envMs = (env: NodeJS.ProcessEnv, names: readonly string[], fallback: number): number => {
  for (const name of names) {
    const value = env[name];
    if (value !== undefined && value !== '') {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed >= 0) {
        return parsed;
      }
    }
  }
  return fallback;
};

const idleTimes = (env: NodeJS.ProcessEnv, id: string, processMs: number, sessionMs: number) => {
  const key = id.toUpperCase().replace(/[^A-Z0-9]/g, '_');
  return {
    processIdleMs: envMs(env, [`SHELLY_${key}_PROCESS_IDLE_MS`, 'SHELLY_AGENT_PROCESS_IDLE_MS'], processMs),
    sessionIdleMs: envMs(env, [`SHELLY_${key}_SESSION_IDLE_MS`, 'SHELLY_AGENT_SESSION_IDLE_MS'], sessionMs),
  };
};

// ─── Command resolution (passive: never runs anything) ──────────────────────

const isExecutableFile = (path: string): boolean => {
  try {
    if (!statSync(path).isFile()) {
      return false;
    }
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/** The command's absolute path: as given if it has a slash, else the first match on PATH. */
export const findExecutable = (command: string, env: NodeJS.ProcessEnv = process.env): string | null => {
  if (command.includes('/')) {
    return isAbsolute(command) && isExecutableFile(command) ? command : null;
  }
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (dir === '') {
      continue;
    }
    const candidate = join(dir, command);
    if (isExecutableFile(candidate)) {
      return candidate;
    }
  }
  return null;
};

/** The claude-agent-acp entry point Shelly ships with, or null if the install is broken. */
export const bundledClaudeAdapter = (): string | null => {
  try {
    const require = createRequire(import.meta.url);
    const manifestPath = require.resolve('@agentclientprotocol/claude-agent-acp/package.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { readonly bin?: Record<string, string> };
    const bin = manifest.bin?.['claude-agent-acp'];
    if (bin === undefined) {
      return null;
    }
    const path = join(dirname(manifestPath), bin);
    statSync(path);
    return path;
  } catch {
    return null;
  }
};

// ─── Environment hygiene ────────────────────────────────────────────────────

/** The env an agent process starts with: the daemon's, minus host-session variables, plus the agent's own. */
export const agentEnvironment = (
  definition: AgentDefinition,
  base: NodeJS.ProcessEnv = process.env,
): Record<string, string> => {
  // CLAUDE_CODE_EXECUTABLE is only ever the one the definition checked (see `claude`).
  const { CLAUDE_CODE_EXECUTABLE: _inherited, ...env } = withoutHostSession(base);
  return { ...env, ...definition.env };
};

// ─── Definitions ────────────────────────────────────────────────────────────

const launchFrom = (
  name: string,
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): AgentDefinition['launch'] => {
  const path = findExecutable(command, env);
  return path
    ? { ok: true, command: path, args }
    : { ok: false, reason: `${name} isn't installed: \`${command}\` isn't on your PATH.` };
};

const claude = (settings: AgentSettings, env: NodeJS.ProcessEnv): AgentDefinition => {
  const name = settings.name ?? BUILTIN_AGENT_NAMES.claude!;
  let launch: AgentDefinition['launch'];
  if (settings.command !== undefined) {
    launch = launchFrom(name, settings.command, settings.args ?? [], env);
  } else {
    const adapter = bundledClaudeAdapter();
    launch = adapter
      ? { ok: true, command: process.execPath, args: [adapter, ...(settings.args ?? [])] }
      : { ok: false, reason: `${name} isn't installed: Shelly's Claude Code adapter is missing. Reinstall Shelly.` };
  }
  // Run the user's own claude (their version, login and settings) when they have one;
  // the adapter falls back to the claude its SDK bundles.
  // An inherited CLAUDE_CODE_EXECUTABLE counts only if it names a real executable.
  const inherited = env.CLAUDE_CODE_EXECUTABLE?.trim();
  const ownClaude = (inherited ? findClaudeExecutable(inherited, env) : null) ?? findClaudeExecutable(null, env);
  return {
    id: 'claude',
    name,
    enabled: settings.enabled ?? true,
    launch,
    env: { ...(ownClaude ? { CLAUDE_CODE_EXECUTABLE: ownClaude } : {}), ...settings.env },
    // claude-agent-acp hands `_meta.claudeCode.options` to the Agent SDK, so the
    // session starts on the model; the config option keeps what it reports in step.
    sessionSetup: settings.model?.trim()
      ? { meta: { claudeCode: { options: { model: settings.model.trim() } } }, ...modelSetup(settings.model) }
      : {},
    supportsFast: true,
    ...idleTimes(env, 'claude', 5 * MINUTE, 3 * MINUTE),
    signInMessage: `${name} isn't signed in. Run \`claude\` once to sign in.`,
    quirks: { rejectEndsTurnCancelled: false, resumeReplacesLiveSession: true },
  };
};

const opencode = (settings: AgentSettings, env: NodeJS.ProcessEnv): AgentDefinition => {
  const name = settings.name ?? BUILTIN_AGENT_NAMES.opencode!;
  const launch = launchFrom(name, settings.command ?? 'opencode', settings.args ?? ['acp'], env);
  return {
    id: 'opencode',
    name,
    enabled: settings.enabled ?? true,
    launch: launch.ok || settings.command !== undefined
      ? launch
      : { ok: false, reason: `${name} isn't installed. Install it from opencode.ai, then try again.` },
    env: { ...settings.env },
    sessionSetup: modelSetup(settings.model),
    supportsFast: true,
    ...idleTimes(env, 'opencode', 2 * MINUTE, 2 * MINUTE),
    signInMessage: `${name} isn't signed in. Run \`opencode auth login\` to sign in.`,
    quirks: { rejectEndsTurnCancelled: true, resumeReplacesLiveSession: false },
  };
};

const custom = (id: string, settings: AgentSettings, env: NodeJS.ProcessEnv): AgentDefinition => {
  const name = settings.name ?? id;
  return {
    id,
    name,
    enabled: settings.enabled ?? true,
    launch: settings.command === undefined
      ? { ok: false, reason: `${name} has no \`command\` in Shelly's config.json.` }
      : launchFrom(name, settings.command, settings.args ?? [], env),
    env: { ...settings.env },
    sessionSetup: modelSetup(settings.model),
    // Fast mode has backends for Claude Code and OpenCode only (src/daemon/fast/).
    supportsFast: false,
    ...idleTimes(env, id, 2 * MINUTE, 2 * MINUTE),
    signInMessage: `${name} isn't signed in. Sign in to it, then try again.`,
    quirks: { rejectEndsTurnCancelled: false, resumeReplacesLiveSession: false },
  };
};

/** Every agent in the config, built-ins first. Includes disabled ones (`enabled: false`). */
export const agentDefinitions = (config: ConfigFile, env: NodeJS.ProcessEnv = process.env): readonly AgentDefinition[] => {
  const settings = config.agents ?? {};
  const definitions = [claude(settings.claude ?? {}, env), opencode(settings.opencode ?? {}, env)];
  for (const [id, entry] of Object.entries(settings)) {
    if (id !== 'claude' && id !== 'opencode') {
      definitions.push(custom(id, entry, env));
    }
  }
  return definitions;
};

/** config.defaultAgent if usable, else Claude Code if available, else OpenCode, else the first available. */
export const defaultAgentId = (config: ConfigFile, definitions: readonly AgentDefinition[]): string | null => {
  const visible = definitions.filter((definition) => definition.enabled);
  const available = visible.filter((definition) => definition.launch.ok);
  const configured = visible.find((definition) => definition.id === config.defaultAgent);
  return (configured ?? available.find((d) => d.id === 'claude') ?? available.find((d) => d.id === 'opencode')
    ?? available[0] ?? visible[0])?.id ?? null;
};

export const agentInfos = (config: ConfigFile, definitions: readonly AgentDefinition[]): readonly AgentInfo[] => {
  const defaultId = defaultAgentId(config, definitions);
  return definitions
    .filter((definition) => definition.enabled)
    .map((definition) => ({
      id: definition.id,
      name: definition.name,
      available: definition.launch.ok,
      unavailableReason: definition.launch.ok ? null : definition.launch.reason,
      supportsFast: definition.supportsFast,
      isDefault: definition.id === defaultId,
    }));
};
