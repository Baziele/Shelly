import { homedir } from 'node:os';
import { join } from 'node:path';

/*
 * Where Shelly keeps its state. Plain functions with no Effect import, so
 * the client can use them on its startup path. Tests set SHELLY_HOME.
 */

export const shellyHome = (env: NodeJS.ProcessEnv = process.env): string =>
  env.SHELLY_HOME || join(homedir(), '.shelly');

export const shellyPaths = (env: NodeJS.ProcessEnv = process.env) => {
  const home = shellyHome(env);
  return {
    home,
    config: join(home, 'config.json'),
    database: join(home, 'state.sqlite'),
    /** The daemon's socket and pid lock. Kept short: macOS limits socket paths to 104 bytes. */
    runDir: join(home, 'run'),
    socket: join(home, 'run', 'daemon.sock'),
    lock: join(home, 'run', 'daemon.lock'),
    logs: join(home, 'logs'),
    daemonLog: join(home, 'logs', 'daemon.log'),
    /** The default working directory for threads, with Shelly's instructions for agents. */
    threadHome: join(home, 'home'),
    /** Scratch space for fast-mode processes (their own config, never the user's). */
    fastHome: join(home, 'fast'),
  };
};
export type ShellyPaths = ReturnType<typeof shellyPaths>;

/** `path` as the user would type it: under their home directory, with `~`. */
export const displayPath = (path: string, home: string | undefined = homedir()): string =>
  home && home !== '/' && (path === home || path.startsWith(`${home}/`)) ? `~${path.slice(home.length)}` : path;

/** Shelly's config file, for messages: `~/.shelly/config.json`, or wherever SHELLY_HOME puts it. */
export const configPathForDisplay = (env: NodeJS.ProcessEnv = process.env): string =>
  displayPath(shellyPaths(env).config, env.HOME || homedir());
