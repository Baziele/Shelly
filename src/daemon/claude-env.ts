import { accessSync, constants, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

/*
 * What every Claude Code process Shelly starts (agent mode and fast mode)
 * shares: the host-session variables to drop, and where the user's own
 * `claude` is.
 */

/*
 * A Claude Code session that started the daemon (or Shelly inside it)
 * exports these; a claude spawned with them acts as part of that session:
 * its session id, notes, messaging socket and token, effort. The list follows
 * T3 Code's (MIT). Auth settings such as CLAUDE_CODE_OAUTH_TOKEN or
 * CLAUDE_CODE_USE_BEDROCK are the user's and stay.
 */
export const HOST_SESSION_VARIABLES: readonly string[] = [
  'CLAUDECODE',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_HOST_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_CHILD_NOTES_DIR',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_DESKTOP_APP_VERSION',
  'CLAUDE_EFFORT',
  'CLAUDE_PID',
  'CLAUDE_AGENT_SDK_VERSION',
  // Commands an Electron host runs inherit this and would start as plain Node.
  'ELECTRON_RUN_AS_NODE',
];

/** `env` without the host-session variables (and without undefined values). */
export const withoutHostSession = (env: NodeJS.ProcessEnv): Record<string, string> => {
  const clean: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && !HOST_SESSION_VARIABLES.includes(key)) {
      clean[key] = value;
    }
  }
  return clean;
};

const isExecutableFile = (path: string): boolean => {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/**
 * The claude executable to run: `explicit` when it is a path, else the
 * first match on PATH, else the installer's usual places. Null when none.
 */
export const findClaudeExecutable = (explicit: string | null, env: NodeJS.ProcessEnv): string | null => {
  const name = explicit ?? 'claude';
  if (name.includes('/')) return isExecutableFile(name) ? name : null;
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (dir === '') continue;
    const candidate = join(dir, name);
    if (isExecutableFile(candidate)) return candidate;
  }
  if (explicit !== null) return null;
  const home = env.HOME || homedir();
  return [join(home, '.local', 'bin', 'claude'), join(home, '.claude', 'local', 'claude')].find(isExecutableFile) ?? null;
};
