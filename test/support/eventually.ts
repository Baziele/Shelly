import { setTimeout as sleep } from 'node:timers/promises';

/**
 * Read a value until `check` accepts it or `timeoutMs` passes, and return
 * the last value read: assert on it afterwards for a useful message. For
 * tests that wait on rendering, which can take longer on a loaded machine
 * but never needs a fixed amount of time.
 */
export const eventually = async <T>(
  read: () => T | Promise<T>,
  check: (value: T) => boolean,
  timeoutMs = 10_000,
): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  let value = await read();
  while (!check(value) && Date.now() < deadline) {
    await sleep(10);
    value = await read();
  }
  return value;
};

/** Structural equality, for `eventually` checks that mirror a deepEqual assertion. */
export const sameAs = <T>(expected: T) => (value: T): boolean => JSON.stringify(value) === JSON.stringify(expected);
