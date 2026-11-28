import assert from 'node:assert/strict';
import { it } from 'node:test';
import * as Effect from 'effect/Effect';
import * as Scope from 'effect/Scope';
import { TestClock } from 'effect/testing';
import { cancelIdle, idleTimer, startIdle } from './idle.js';

/* On the test clock: time moves only when the test says, so load can't change the outcome. */

it('concurrent starts leave one timer, and only the latest fires', async () => {
  const fired: number[] = [];
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const scope = yield* Scope.Scope;
    const timer = idleTimer();
    yield* Effect.all(
      [1, 2, 3, 4].map((n) => startIdle(timer, scope, 50, (current, claim) =>
        Effect.sync(() => {
          if (current()) {
            claim();
            fired.push(n);
          }
        }))),
      { concurrency: 'unbounded', discard: true },
    );
    assert.ok(timer.fiber !== null);
    yield* TestClock.adjust('1 hour');
    yield* Effect.yieldNow;
    assert.equal(timer.fiber, null);
    assert.equal(timer.token, null);
  })).pipe(Effect.provide(TestClock.layer())));
  assert.equal(fired.length, 1);
});

it('cancel stops a pending timer', async () => {
  let fired = false;
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const scope = yield* Scope.Scope;
    const timer = idleTimer();
    yield* startIdle(timer, scope, 50, () => Effect.sync(() => {
      fired = true;
    }));
    yield* cancelIdle(timer);
    yield* TestClock.adjust('1 hour');
    yield* Effect.yieldNow;
  })).pipe(Effect.provide(TestClock.layer())));
  assert.equal(fired, false);
});

it('a restart moves the deadline', async () => {
  const fired: number[] = [];
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const scope = yield* Scope.Scope;
    const timer = idleTimer();
    const start = startIdle(timer, scope, 100, (current, claim) => Effect.sync(() => {
      if (current()) {
        claim();
        fired.push(Date.now());
      }
    }));
    yield* start;
    yield* TestClock.adjust('60 millis');
    yield* start; // restarted 60 ms in: due at 160
    yield* TestClock.adjust('60 millis'); // 120: the first deadline passed
    yield* Effect.yieldNow;
    assert.equal(fired.length, 0);
    yield* TestClock.adjust('60 millis'); // 180
    yield* Effect.yieldNow;
    assert.equal(fired.length, 1);
  })).pipe(Effect.provide(TestClock.layer())));
});
