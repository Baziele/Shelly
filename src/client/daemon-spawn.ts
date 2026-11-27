import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { shellyPaths } from '../protocol/paths.js';
import { probeSocket } from '../protocol/probe.js';

/*
 * Starting the daemon from a client. Plain node, no Effect: a terminal can
 * fire `ensureDaemonStarted()` right after its shell spawns at almost no cost.
 */

export interface DaemonStartOptions {
  readonly env?: NodeJS.ProcessEnv | undefined;
  /** The script that runs `shelly daemon`; defaults to this process's entry script. */
  readonly entry?: string | undefined;
  /** Node flags for the daemon; defaults to this process's (so tsx dev mode works). */
  readonly execArgv?: readonly string[] | undefined;
  /** How long to wait for a spawned daemon to answer. */
  readonly startTimeoutMs?: number | undefined;
}

export class DaemonStartFailed extends Error {
  constructor(readonly logPath: string) {
    super(`Shelly's background service did not start. Its log is at ${logPath}.`);
    this.name = 'DaemonStartFailed';
  }
}

const DEFAULT_START_TIMEOUT_MS = 3000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Start a daemon in the background, detached from this process, its output going to the log. */
export const spawnDaemon = (options: DaemonStartOptions = {}): number | undefined => {
  const env = options.env ?? process.env;
  const paths = shellyPaths(env);
  const entry = options.entry ?? process.argv[1];
  if (!entry) {
    throw new Error('Cannot tell which script starts the daemon.');
  }
  mkdirSync(paths.logs, { recursive: true, mode: 0o700 });
  const log = openSync(paths.daemonLog, 'a', 0o600);
  try {
    const child = spawn(process.execPath, [...(options.execArgv ?? process.execArgv), entry, 'daemon'], {
      detached: true,
      stdio: ['ignore', log, log],
      env,
    });
    child.on('error', () => {});
    child.unref();
    return child.pid;
  } finally {
    closeSync(log);
  }
};

/** Wait for something to answer on the socket, backing off; false after `timeoutMs`. */
export const waitForSocket = async (socket: string, timeoutMs: number): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  let delay = 5;
  while (Date.now() < deadline) {
    if (await probeSocket(socket, Math.max(50, Math.min(500, deadline - Date.now())))) {
      return true;
    }
    await sleep(Math.min(delay, Math.max(0, deadline - Date.now())));
    delay = Math.min(delay * 2, 100);
  }
  return probeSocket(socket, 100);
};

/** Wait until nothing answers on the socket any more. */
export const waitForSocketGone = async (socket: string, timeoutMs: number): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await probeSocket(socket, 100))) {
      return true;
    }
    await sleep(20);
  }
  return false;
};

const starting = new Map<string, Promise<void>>();

/**
 * Make sure a daemon is running, starting one if nothing answers. Concurrent
 * calls in one process share one attempt; a race with another terminal is
 * settled by the daemon's lock.
 */
export const ensureDaemonStarted = (options: DaemonStartOptions = {}): Promise<void> => {
  const paths = shellyPaths(options.env ?? process.env);
  const inFlight = starting.get(paths.socket);
  if (inFlight) {
    return inFlight;
  }
  const attempt = (async () => {
    if (await probeSocket(paths.socket)) {
      return;
    }
    spawnDaemon(options);
    if (!(await waitForSocket(paths.socket, options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS))) {
      throw new DaemonStartFailed(paths.daemonLog);
    }
  })().finally(() => starting.delete(paths.socket));
  starting.set(paths.socket, attempt);
  return attempt;
};
