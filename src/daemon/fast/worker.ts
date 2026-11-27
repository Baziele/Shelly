/*
 * A fast-mode worker: one warm model process that answers one request at a
 * time and keeps the conversation it has had. Each agent's backend makes
 * them; the pool decides when.
 *
 * Plain callbacks rather than Effect: this is the per-token hot path, and
 * the process, its pipes and its timers are callback APIs anyway. The
 * FastService layer is the Effect boundary.
 */

/** Why a request failed. `unavailable`: the agent can't be used until the user acts (install, sign in). */
export type WorkerFailure =
  | { readonly kind: 'unavailable'; readonly reason: string }
  | { readonly kind: 'failed'; readonly reason: string };

export interface TurnHandlers {
  readonly onDelta: (text: string) => void;
  /** The whole reply text, raw. */
  readonly onDone: (text: string) => void;
  readonly onFailure: (failure: WorkerFailure) => void;
}

export interface Turn {
  /** Stop the turn now. No handler is called afterwards. */
  readonly cancel: () => void;
}

export interface FastWorker {
  readonly pid: number | undefined;
  /** False once the process has exited or is being killed. */
  readonly alive: boolean;
  /**
   * Send one request. A turn still running is cancelled first, and its
   * handlers fail; the new one waits for the old one to settle.
   */
  readonly send: (message: string, handlers: TurnHandlers) => Turn;
  /** Kill the process group. Safe to call more than once. */
  readonly kill: () => void;
  /** Resolves when the process has exited. */
  readonly exited: Promise<void>;
}

export interface FastBackend {
  /** Identifies what spawn makes (model, executable): workers made under another key are not reused. */
  readonly key: string;
  /** Start a worker; returns at once, before the process is ready. */
  readonly spawn: () => FastWorker | WorkerFailure;
}

export const isWorkerFailure = (value: FastWorker | WorkerFailure): value is WorkerFailure => 'kind' in value;
