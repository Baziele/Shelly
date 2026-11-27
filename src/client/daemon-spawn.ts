import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
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

/**
 * Long enough for a daemon that is stopping to let go of its lock (it may
 * give stuck turns 2 s to end) and for the new one to start. A daemon that
 * fails to start exits, which ends the wait early.
 */
const DEFAULT_START_TIMEOUT_MS = 10_000;
/** After the spawned daemon exited: how long another daemon (the one it deferred to) gets to answer. */
const AFTER_EXIT_GRACE_MS = 500;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const LOADER_FLAGS = new Set(['--import', '--loader', '--experimental-loader', '--require', '-r']);

/** A module a loader flag names, made absolute so it still resolves from the daemon's own directory. */
const absoluteSpecifier = (specifier: string, from: string): string => {
  if (specifier.startsWith('file:') || isAbsolute(specifier)) {
    return specifier;
  }
  if (specifier.startsWith('.')) {
    return pathToFileURL(resolve(from, specifier)).href;
  }
  try {
    return import.meta.resolve(specifier);
  } catch {
    return specifier;
  }
};

/** This process's Node flags with loader modules (tsx in dev mode, say) resolved from `cwd`. */
export const portableExecArgv = (execArgv: readonly string[], cwd = process.cwd()): string[] => {
  const out: string[] = [];
  for (let index = 0; index < execArgv.length; index++) {
    const arg = execArgv[index]!;
    const [flag, inline] = arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, undefined];
    if (!LOADER_FLAGS.has(flag)) {
      out.push(arg);
    } else if (inline !== undefined) {
      out.push(`${flag}=${absoluteSpecifier(inline, cwd)}`);
    } else if (index + 1 < execArgv.length) {
      out.push(flag, absoluteSpecifier(execArgv[++index]!, cwd));
    } else {
      out.push(arg);
    }
  }
  return out;
};

/**
 * The daemon's Node flags: this process's, made portable, plus
 * --experimental-ffi, which the daemon's lock needs (flock through
 * node:ffi), with its experimental warning kept out of the log.
 */
export const daemonExecArgv = (execArgv: readonly string[], cwd = process.cwd()): string[] => {
  const args = portableExecArgv(execArgv, cwd);
  if (!args.includes('--experimental-ffi')) {
    args.unshift('--experimental-ffi');
  }
  if (!args.some((arg) => arg === '--no-warnings' || arg.startsWith('--disable-warning'))) {
    args.unshift('--disable-warning=ExperimentalWarning');
  }
  return args;
};

/** Start a daemon in the background, detached from this process, its output going to the log. */
export const spawnDaemon = (options: DaemonStartOptions = {}): number | undefined => startDaemonProcess(options).pid;

/** As spawnDaemon; `exited` resolves if the daemon exits while this process runs. */
const startDaemonProcess = (options: DaemonStartOptions): { readonly pid: number | undefined; readonly exited: Promise<void> } => {
  const env = options.env ?? process.env;
  const paths = shellyPaths(env);
  const entry = options.entry ?? process.argv[1];
  if (!entry) {
    throw new Error('Cannot tell which script starts the daemon.');
  }
  mkdirSync(paths.logs, { recursive: true, mode: 0o700 });
  const log = openSync(paths.daemonLog, 'a', 0o600);
  try {
    const child = spawn(process.execPath, [...daemonExecArgv(options.execArgv ?? process.execArgv), resolve(entry), 'daemon'], {
      // Its own session, so closing the terminal does not take it down, and
      // its own directory, so it never holds on to the user's.
      detached: true,
      cwd: paths.home,
      stdio: ['ignore', log, log],
      env,
    });
    const exited = new Promise<void>((resolve) => {
      child.once('exit', () => resolve());
      child.once('error', () => resolve());
    });
    child.unref();
    return { pid: child.pid, exited };
  } finally {
    closeSync(log);
  }
};

/** Wait for something to answer on the socket, backing off; false after `timeoutMs`, or soon after `giveUp` resolves. */
export const waitForSocket = async (socket: string, timeoutMs: number, giveUp?: Promise<void>): Promise<boolean> => {
  let deadline = Date.now() + timeoutMs;
  void giveUp?.then(() => {
    deadline = Math.min(deadline, Date.now() + AFTER_EXIT_GRACE_MS);
  });
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
    const daemon = startDaemonProcess(options);
    if (!(await waitForSocket(paths.socket, options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS, daemon.exited))) {
      throw new DaemonStartFailed(paths.daemonLog);
    }
  })().finally(() => starting.delete(paths.socket));
  starting.set(paths.socket, attempt);
  return attempt;
};
