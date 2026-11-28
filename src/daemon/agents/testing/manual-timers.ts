import * as Deferred from 'effect/Deferred';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';

/*
 * Idle timers a test fires by hand (AgentRuntimeOptions.sleep), so lifecycle
 * tests assert on which timers are waiting instead of on wall-clock windows.
 */

export interface ManualTimer {
  readonly ms: number;
  /** The timer ended: fired, or interrupted because it was restarted or cancelled. */
  readonly done: () => boolean;
  /** It was interrupted rather than fired. */
  readonly interrupted: () => boolean;
  readonly fire: () => void;
}

export const manualTimers = () => {
  const all: ManualTimer[] = [];
  const sleep = (ms: number): Effect.Effect<void> =>
    Effect.suspend(() => {
      const deferred = Deferred.makeUnsafe<void>();
      let done = false;
      let interrupted = false;
      all.push({
        ms,
        done: () => done,
        interrupted: () => interrupted,
        fire: () => {
          Deferred.doneUnsafe(deferred, Exit.void);
        },
      });
      return Deferred.await(deferred).pipe(
        Effect.onInterrupt(() => Effect.sync(() => {
          interrupted = true;
        })),
        Effect.ensuring(Effect.sync(() => {
          done = true;
        })),
      );
    });
  return {
    sleep,
    /** Timers of this duration still waiting, oldest first. */
    waiting: (ms: number): ManualTimer[] => all.filter((timer) => timer.ms === ms && !timer.done()),
  };
};

/** Polls `check` until it holds. The bound only limits how long a failing test takes. */
export const eventually = (check: () => boolean, what: string, ms = 15_000) =>
  Effect.gen(function* () {
    const deadline = Date.now() + ms;
    while (!check()) {
      if (Date.now() > deadline) {
        return yield* Effect.die(new Error(`timed out waiting for ${what}`));
      }
      yield* Effect.sleep('10 millis');
    }
  });
