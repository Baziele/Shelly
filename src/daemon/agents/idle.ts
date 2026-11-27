import * as Effect from 'effect/Effect';
import * as Fiber from 'effect/Fiber';
import type * as Scope from 'effect/Scope';

/*
 * Idle timers for sessions and processes.
 */

export const stopFiber = (fiber: Fiber.Fiber<void> | null): Effect.Effect<void> =>
  fiber === null ? Effect.void : Fiber.interrupt(fiber);

/**
 * One idle timer slot. Each start replaces the last, and only the latest start
 * may fire: two concurrent starts never leave a second, untracked timer behind.
 */
export interface IdleTimer {
  fiber: Fiber.Fiber<void> | null;
  token: object | null;
}

export const idleTimer = (): IdleTimer => ({ fiber: null, token: null });

export const cancelIdle = (timer: IdleTimer): Effect.Effect<void> =>
  Effect.suspend(() => {
    const fiber = timer.fiber;
    timer.fiber = null;
    timer.token = null;
    return stopFiber(fiber);
  });

/**
 * (Re)starts the timer. After `ms`, `fire` runs with a check that is true only
 * while this start is still the latest; call it under the owner's lock, then
 * `claim` the timer before doing the work (the fiber is done with it then).
 */
export const startIdle = (
  timer: IdleTimer,
  scope: Scope.Scope,
  ms: number,
  fire: (current: () => boolean, claim: () => void) => Effect.Effect<void>,
): Effect.Effect<void> =>
  Effect.suspend(() => {
    const token = {};
    const previous = timer.fiber;
    timer.fiber = null;
    timer.token = token;
    const current = () => timer.token === token;
    const claim = () => {
      timer.token = null;
      timer.fiber = null;
    };
    return Effect.sleep(ms).pipe(
      Effect.andThen(Effect.suspend(() => current() ? fire(current, claim) : Effect.void)),
      Effect.forkIn(scope),
      Effect.flatMap((fiber) => Effect.suspend(() => {
        if (current()) {
          timer.fiber = fiber;
          return Effect.void;
        }
        return Fiber.interrupt(fiber);
      })),
      Effect.andThen(stopFiber(previous)),
    );
  });
