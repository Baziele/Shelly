/*
 * What the interactive `shelly` does about errors nothing caught. The shell
 * is the user's work, and the terminal theirs: whatever happens, it is
 * never left in raw mode with the cursor hidden.
 *
 * - An uncaught exception ends Shelly. Node leaves the process in an
 *   undefined state after one (a throw inside node-pty or halfway through
 *   drawing could leave the pty or the terminal half torn down), so
 *   carrying on could look fine and be broken: the terminal is restored,
 *   the shell is ended with Shelly, and the user is told where the log is.
 * - An unhandled rejection (a daemon call nobody caught, say) leaves
 *   nothing half done: it is logged and Shelly carries on, the shell
 *   untouched; a terminal Shelly was drawing on comes back by itself (the
 *   busy watchdog). Only rejections coming in a storm, which means Shelly
 *   itself is broken, end it as above.
 */

export const STORM = { errors: 5, withinMs: 10_000 } as const;

/** Leaves the terminal usable whatever was drawing: attributes reset, cursor shown. */
const RESET_TERMINAL = '\u001b[0m\u001b[?25h';

export interface CrashGuardOptions {
  /** Raw mode off, attributes reset, cursor shown, input no longer read (HostTerminal.stop). */
  readonly restoreTerminal: () => void;
  /** End the user's shell, which would otherwise outlive Shelly on a pty nobody reads. */
  readonly killShell: () => void;
  readonly log: (what: string, error: unknown) => void;
  readonly logPath: string;
  /** Where the message goes (stderr). */
  readonly write: (text: string) => void;
  readonly exit: (code: number) => void;
  readonly now?: () => number;
}

export interface CrashGuard {
  readonly uncaughtException: (error: unknown) => void;
  readonly unhandledRejection: (reason: unknown) => void;
}

export const crashGuard = (options: CrashGuardOptions): CrashGuard => {
  const now = options.now ?? Date.now;
  let crashed = false;
  const attempt = (step: () => void): void => {
    try {
      step();
    } catch {
      // Already broken: the next step still runs.
    }
  };

  const crash = (error: unknown): void => {
    if (crashed) {
      return;
    }
    crashed = true;
    attempt(() => options.restoreTerminal());
    attempt(() => options.killShell());
    const message = error instanceof Error ? error.message : String(error);
    attempt(() => options.write(`${RESET_TERMINAL}\r\nshelly crashed: ${message.split('\n')[0]}\r\nThe details are in ${options.logPath}\r\n`));
    options.exit(1);
  };

  const recent: number[] = [];
  return {
    uncaughtException: (error) => {
      options.log('uncaught exception', error);
      crash(error);
    },
    unhandledRejection: (reason) => {
      options.log('unhandled rejection', reason);
      const at = now();
      recent.push(at);
      while (recent.length > 0 && at - recent[0]! > STORM.withinMs) {
        recent.shift();
      }
      if (recent.length >= STORM.errors) {
        crash(reason);
      }
    },
  };
};
