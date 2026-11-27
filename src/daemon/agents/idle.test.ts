import assert from 'node:assert/strict';
import { it } from 'node:test';
import * as Effect from 'effect/Effect';
import * as Scope from 'effect/Scope';
import { cancelIdle, idleTimer, startIdle } from './idle.js';

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
    yield* Effect.sleep('150 millis');
    assert.equal(timer.fiber, null);
    assert.equal(timer.token, null);
  })));
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
    yield* Effect.sleep('100 millis');
  })));
  assert.equal(fired, false);
});
