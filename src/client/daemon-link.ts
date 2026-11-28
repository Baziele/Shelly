import { homedir } from 'node:os';
import type { DaemonClient, HelloResult } from './daemon-client.js';
import { ensureDaemonStarted } from './daemon-spawn.js';

/*
 * The terminal's way to the daemon, kept off the startup path. Starting the
 * daemon is plain node (a socket probe, maybe a spawn); the connection is
 * imported only when Shelly is about to be used (see Shelly.loadUi).
 *
 * If the daemon cannot start, Shelly carries on as a plain shell: `get()`
 * rejects with a one-line reason naming the daemon's log, and tries again
 * the next time it is called.
 */

/** How long a background start may take; tsx in development is much slower than a build. */
const DEFAULT_START_TIMEOUT_MS = 10_000;
/** How long `dispose()` waits for goodbyes (detaching the thread) before closing anyway. */
const DISPOSE_TIMEOUT_MS = 500;

export interface DaemonLinkOptions {
  readonly env: NodeJS.ProcessEnv;
  /** Overrides for tests: which script runs `shelly daemon`, and with which node flags. */
  readonly entry?: string;
  readonly execArgv?: readonly string[];
  /** Test seams: how the daemon is started, and how the client is made. */
  readonly ensureStarted?: (options: ReturnType<DaemonLink['startOptions']>) => Promise<void>;
  readonly createClient?: (options: ReturnType<DaemonLink['startOptions']>) => Promise<DaemonClient>;
}

class Disposed extends Error {
  constructor() {
    super('Shelly is exiting.');
  }
}

export class DaemonLink {
  private client: DaemonClient | undefined;
  private loading: Promise<DaemonClient> | undefined;
  private started: Promise<void> | undefined;
  private failure: string | undefined;
  private disposed = false;

  constructor(private readonly options: DaemonLinkOptions) {}

  /** The last reason the daemon could not be reached, until it can be again. */
  get lastError(): string | undefined {
    return this.failure;
  }

  /** The client, if it is loaded; never loads it. */
  get loaded(): DaemonClient | undefined {
    return this.client;
  }

  /** Make sure a daemon is running. Cheap: a socket probe, maybe a spawn. Safe to call often. */
  startDaemon(): Promise<void> {
    this.started ??= (this.options.ensureStarted ?? ensureDaemonStarted)(this.startOptions()).catch((error: unknown) => {
      this.started = undefined;
      this.failure = describe(error);
      throw error;
    });
    return this.started;
  }

  /** The connected client: starts the daemon and loads the connection if need be. */
  get(): Promise<DaemonClient> {
    if (this.disposed) {
      return Promise.reject(new Disposed());
    }
    this.loading ??= this.load().then(
      (client) => {
        this.failure = undefined;
        return client;
      },
      (error: unknown) => {
        this.loading = undefined;
        this.failure = describe(error);
        throw new Error(this.failure);
      },
    );
    return this.loading;
  }

  /** Connect again after the daemon went away (starting a new one); resolves with its hello. */
  async reconnect(): Promise<HelloResult> {
    const client = await this.get();
    try {
      const hello = await client.connect();
      this.failure = undefined;
      return hello;
    } catch (error) {
      this.failure = describe(error);
      throw new Error(this.failure);
    }
  }

  /**
   * Let go of the daemon: `goodbye` runs first (detach the thread), bounded
   * in time, then the connection closes so the process can exit.
   */
  async dispose(goodbye?: (client: DaemonClient) => Promise<unknown>): Promise<void> {
    this.disposed = true;
    const client = this.client;
    if (!client) {
      return;
    }
    const bounded = <T>(promise: Promise<T>) =>
      Promise.race([promise.catch(() => undefined), new Promise<void>((resolve) => setTimeout(resolve, DISPOSE_TIMEOUT_MS).unref())]);
    if (goodbye) {
      await bounded(goodbye(client));
    }
    await bounded(client.dispose());
  }

  /** Checks after every await: a link disposed meanwhile makes no client, and closes one it made. */
  private async load(): Promise<DaemonClient> {
    await this.startDaemon();
    this.throwIfDisposed();
    if (!this.client) {
      const client = await this.makeClient();
      if (this.disposed) {
        await client.dispose().catch(() => undefined);
        throw new Disposed();
      }
      this.client ??= client;
    }
    const client = this.client;
    await client.connect();
    if (this.disposed) {
      await client.dispose().catch(() => undefined);
      throw new Disposed();
    }
    return client;
  }

  private async makeClient(): Promise<DaemonClient> {
    if (this.options.createClient) {
      return this.options.createClient(this.startOptions());
    }
    const { DaemonClient } = await import('./daemon-client.js');
    return new DaemonClient(this.startOptions());
  }

  private throwIfDisposed(): void {
    if (this.disposed) {
      throw new Disposed();
    }
  }

  /** How the daemon is started (for the test seams). */
  startOptions() {
    const timeout = Number(this.options.env.SHELLY_DAEMON_START_TIMEOUT_MS);
    return {
      env: this.options.env,
      entry: this.options.entry,
      execArgv: this.options.execArgv,
      startTimeoutMs: timeout > 0 ? timeout : DEFAULT_START_TIMEOUT_MS,
    };
  }
}

const describe = (error: unknown): string => {
  const text = (error instanceof Error ? error.message : String(error)).split('\n')[0]?.trim();
  if (!text) {
    return "Shelly's background service is not answering.";
  }
  // One line under the input: paths under the home directory with `~`, so the log's fits.
  const home = homedir();
  return home.length > 1 ? text.replaceAll(home, '~') : text;
};
