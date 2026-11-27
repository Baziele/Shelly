// Shelly-only test helper, not part of upstream effect-acp.
//
// The upstream tests use @effect/vitest. This module implements the small part
// of its API they need (`it.effect`, `it.effect.each`, `it.layer`, `describe`,
// and the chai `assert` / vitest `expect` calls they make) on top of node:test,
// so the ported tests only change their import line.
//
// Like @effect/vitest, every Effect test runs scoped, with TestClock and
// TestConsole provided. `it.layer(layer)` provides `layer` to each test of the
// block; unlike @effect/vitest it builds the layer once per test instead of
// once per block, so no test can see another test's TestClock.

import * as nodeAssert from "node:assert/strict";
import * as nodeTest from "node:test";
import { inspect } from "node:util";

import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import * as TestConsole from "effect/testing/TestConsole";

const DEFAULT_TIMEOUT_MS = 30_000;

const TestEnv = Layer.mergeAll(TestConsole.layer, TestClock.layer());

type TestOptions = number | { readonly timeout?: number };

const toNodeOptions = (timeout?: TestOptions): nodeTest.TestOptions => ({
  timeout: (typeof timeout === "number" ? timeout : timeout?.timeout) ?? DEFAULT_TIMEOUT_MS,
});

const runTest = async <A, E>(effect: Effect.Effect<A, E>): Promise<void> => {
  const exit = await Effect.runPromiseExit(effect);
  if (Exit.isFailure(exit)) {
    const error = Cause.squash(exit.cause);
    if (error instanceof Error && Cause.prettyErrors(exit.cause).length <= 1) {
      throw error;
    }
    throw new Error(Cause.pretty(exit.cause));
  }
};

// Vitest's `it.for` name interpolation: printf-style `%s`/`%d`/`%i`/`%j`/`%o`
// consume the case (or the next tuple element), and `$key` reads a field.
const formatName = (template: string, testCase: unknown): string => {
  const show = (value: unknown) => (typeof value === "string" ? value : inspect(value));
  const args = Array.isArray(testCase) ? [...testCase] : [testCase];
  let index = 0;
  return template
    .replace(/%[sdijo%]/g, (token) => (token === "%%" ? "%" : show(args[index++])))
    .replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (match, key: string) =>
      testCase !== null && typeof testCase === "object" && key in testCase
        ? show((testCase as Record<string, unknown>)[key])
        : match,
    );
};

export interface EffectTester<R> {
  <A, E>(name: string, self: () => Effect.Effect<A, E, R>, timeout?: TestOptions): void;
  readonly skip: <A, E>(
    name: string,
    self: () => Effect.Effect<A, E, R>,
    timeout?: TestOptions,
  ) => void;
  readonly each: <T>(
    cases: ReadonlyArray<T>,
  ) => <A, E>(name: string, self: (args: T) => Effect.Effect<A, E, R>, timeout?: TestOptions) => void;
}

export interface Methods<R> {
  readonly effect: EffectTester<R | Scope.Scope>;
  readonly layer: <R2, E2>(
    layer: Layer.Layer<R2, E2>,
  ) => (name: string, f: (it: Methods<R | R2>) => void) => void;
}

// Each block wraps a test's Effect with what it provides, outermost block last.
type Provide = (effect: Effect.Effect<any, any, any>) => Effect.Effect<any, any, never>;

const makeMethods = <R>(provide: Provide): Methods<R> => {
  const register = (name: string, self: () => Effect.Effect<any, any, any>, timeout?: TestOptions) =>
    void nodeTest.it(name, toNodeOptions(timeout), () => runTest(provide(Effect.suspend(self))));
  const effect: EffectTester<R | Scope.Scope> = Object.assign(register, {
    skip: (name: string, _self: unknown, timeout?: TestOptions) =>
      void nodeTest.it.skip(name, toNodeOptions(timeout)),
    each:
      <T>(cases: ReadonlyArray<T>) =>
      (name: string, self: (args: T) => Effect.Effect<any, any, any>, timeout?: TestOptions) => {
        for (const testCase of cases) {
          register(formatName(name, testCase), () => self(testCase), timeout);
        }
      },
  });
  return {
    effect,
    layer:
      <R2, E2>(layer: Layer.Layer<R2, E2>) =>
      (name: string, f: (it: Methods<R | R2>) => void) =>
        void nodeTest.describe(name, () =>
          f(makeMethods<R | R2>((self) => provide(Effect.provide(self, Layer.orDie(layer))))),
        ),
  };
};

const topLevel = makeMethods<never>(
  (self) => Effect.provide(Effect.scoped(self), TestEnv) as Effect.Effect<unknown, unknown>,
);

const plainTest = (name: string, fn: () => void | Promise<void>, timeout?: TestOptions) =>
  void nodeTest.it(name, toNodeOptions(timeout), fn);

export const it: typeof plainTest & Methods<never> = Object.assign(plainTest, topLevel);

export const describe = (name: string, fn: () => void): void => void nodeTest.describe(name, fn);

// ---------------------------------------------------------------------------
// chai `assert` subset

const fail = (message: string, actual?: unknown, expected?: unknown, operator?: string): never => {
  throw new nodeAssert.AssertionError({ message, actual, expected, operator: operator ?? "fail" });
};

const describeValue = (value: unknown) => inspect(value, { depth: 4 });

// chai's type-detect, as used by `assert.typeOf`.
const typeOf = (value: unknown): string => {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  const primitive = typeof value;
  if (primitive !== "object" && primitive !== "function") return primitive;
  return Object.prototype.toString.call(value).slice(8, -1).toLowerCase();
};

const enumerableKeys = (value: object): Array<PropertyKey> => {
  const keys: Array<PropertyKey> = [];
  for (const key in value) keys.push(key);
  for (const symbol of Object.getOwnPropertySymbols(value)) {
    if (Object.getOwnPropertyDescriptor(value, symbol)?.enumerable) keys.push(symbol);
  }
  return keys;
};

// chai's deep-eql: compares type tags and enumerable keys (own and inherited),
// not prototypes, so a class instance equals a plain object with the same fields.
// With `ignoreUndefined` (vitest's toEqual), undefined-valued keys count as absent.
const deepEqual = (
  left: unknown,
  right: unknown,
  ignoreUndefined = false,
  seen = new Map<object, object>(),
): boolean => {
  if (left === right) return left !== 0 || 1 / (left as number) === 1 / (right as number);
  if (Number.isNaN(left) && Number.isNaN(right)) return true;
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") {
    return false;
  }
  const tag = typeOf(left);
  if (tag !== typeOf(right)) return false;
  if (seen.get(left) === right) return true;
  seen.set(left, right);
  if (left instanceof Date && right instanceof Date) return left.getTime() === right.getTime();
  if (left instanceof RegExp && right instanceof RegExp) return String(left) === String(right);
  if (left instanceof Error) return false;
  if (left instanceof Map && right instanceof Map) {
    if (left.size !== right.size) return false;
    for (const [key, value] of left) {
      if (!right.has(key) || !deepEqual(value, right.get(key), ignoreUndefined, seen)) return false;
    }
    return true;
  }
  if (left instanceof Set && right instanceof Set) {
    if (left.size !== right.size) return false;
    const rightValues = [...right];
    return [...left].every((value) => rightValues.some((other) => deepEqual(value, other, ignoreUndefined, seen)));
  }
  if (ArrayBuffer.isView(left) || Array.isArray(left)) {
    const leftItems = left as unknown as ArrayLike<unknown>;
    const rightItems = right as unknown as ArrayLike<unknown>;
    if (leftItems.length !== rightItems.length) return false;
    for (let index = 0; index < leftItems.length; index++) {
      if (!deepEqual(leftItems[index], rightItems[index], ignoreUndefined, seen)) return false;
    }
    return true;
  }
  const keysOf = (value: object) =>
    enumerableKeys(value).filter(
      (key) => !ignoreUndefined || (value as Record<PropertyKey, unknown>)[key] !== undefined,
    );
  const leftKeys = keysOf(left);
  const rightKeys = keysOf(right);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every(
    (key) =>
      rightKeys.includes(key) &&
      deepEqual(
        (left as Record<PropertyKey, unknown>)[key],
        (right as Record<PropertyKey, unknown>)[key],
        ignoreUndefined,
        seen,
      ),
  );
};

const includes = (
  haystack: unknown,
  needle: unknown,
  equals: (left: unknown, right: unknown) => boolean,
): boolean => {
  if (typeof haystack === "string") return haystack.includes(String(needle));
  if (Array.isArray(haystack)) return haystack.some((item) => equals(item, needle));
  if (haystack instanceof Set) return [...haystack].some((item) => equals(item, needle));
  if (haystack !== null && typeof haystack === "object" && needle !== null && typeof needle === "object") {
    return Object.entries(needle).every(([key, value]) =>
      equals((haystack as Record<string, unknown>)[key], value),
    );
  }
  return fail(`cannot check whether ${describeValue(haystack)} includes ${describeValue(needle)}`);
};

const lengthOfValue = (value: unknown): number | undefined => {
  if (value instanceof Map || value instanceof Set) return value.size;
  if (typeof value === "string" || Array.isArray(value) || ArrayBuffer.isView(value)) {
    return (value as ArrayLike<unknown>).length;
  }
  return undefined;
};

export interface Assert {
  fail(message?: string): never;
  equal(actual: unknown, expected: unknown, message?: string): void;
  notEqual(actual: unknown, expected: unknown, message?: string): void;
  strictEqual(actual: unknown, expected: unknown, message?: string): void;
  deepEqual(actual: unknown, expected: unknown, message?: string): void;
  deepInclude(haystack: unknown, needle: unknown, message?: string): void;
  include(haystack: unknown, needle: unknown, message?: string): void;
  notInclude(haystack: unknown, needle: unknown, message?: string): void;
  exists<T>(value: T, message?: string): asserts value is NonNullable<T>;
  isDefined<T>(value: T, message?: string): asserts value is Exclude<T, undefined>;
  isUndefined(value: unknown, message?: string): asserts value is undefined;
  isTrue(value: unknown, message?: string): asserts value is true;
  isFalse(value: unknown, message?: string): asserts value is false;
  isEmpty(value: unknown, message?: string): void;
  isAtMost(value: number, maximum: number, message?: string): void;
  lengthOf(value: unknown, length: number, message?: string): void;
  typeOf(value: unknown, type: string, message?: string): void;
  instanceOf<T>(
    value: unknown,
    constructor: abstract new (...args: Array<any>) => T,
    message?: string,
  ): asserts value is T;
}

const check = (
  ok: boolean,
  message: string | undefined,
  detail: () => string,
  actual?: unknown,
  expected?: unknown,
  operator?: string,
): void => {
  if (!ok) fail(message ? `${message}: ${detail()}` : detail(), actual, expected, operator);
};

export const assert: Assert = {
  fail: (message) => fail(message ?? "assert.fail()"),
  equal: (actual, expected, message) =>
    // chai's assert.equal is loose equality.
    check(actual == expected, message, () => "expected values to be ==", actual, expected, "=="),
  notEqual: (actual, expected, message) =>
    check(actual != expected, message, () => "expected values to be !=", actual, expected, "!="),
  strictEqual: (actual, expected, message) =>
    check(actual === expected, message, () => "expected values to be ===", actual, expected, "==="),
  deepEqual: (actual, expected, message) =>
    check(
      deepEqual(actual, expected),
      message,
      () => "expected values to be deeply equal",
      actual,
      expected,
      "deepEqual",
    ),
  deepInclude: (haystack, needle, message) =>
    check(
      includes(haystack, needle, (left, right) => deepEqual(left, right)),
      message,
      () => `expected ${describeValue(haystack)} to deeply include ${describeValue(needle)}`,
    ),
  include: (haystack, needle, message) =>
    check(
      includes(haystack, needle, (left, right) => left === right),
      message,
      () => `expected ${describeValue(haystack)} to include ${describeValue(needle)}`,
    ),
  notInclude: (haystack, needle, message) =>
    check(
      !includes(haystack, needle, (left, right) => left === right),
      message,
      () => `expected ${describeValue(haystack)} not to include ${describeValue(needle)}`,
    ),
  exists: (value, message) =>
    check(value !== null && value !== undefined, message, () => "expected value to exist", value),
  isDefined: (value, message) =>
    check(value !== undefined, message, () => "expected value to be defined", value),
  isUndefined: (value, message) =>
    check(value === undefined, message, () => "expected value to be undefined", value),
  isTrue: (value, message) => check(value === true, message, () => "expected true", value, true),
  isFalse: (value, message) => check(value === false, message, () => "expected false", value, false),
  isEmpty: (value, message) => {
    const length =
      lengthOfValue(value) ??
      (value !== null && typeof value === "object" ? Object.keys(value).length : undefined);
    check(length === 0, message, () => `expected ${describeValue(value)} to be empty`, value);
  },
  isAtMost: (value, maximum, message) =>
    check(value <= maximum, message, () => `expected ${value} to be at most ${maximum}`),
  lengthOf: (value, length, message) =>
    check(
      lengthOfValue(value) === length,
      message,
      () => `expected length ${length}, got ${lengthOfValue(value)}`,
      lengthOfValue(value),
      length,
    ),
  typeOf: (value, type, message) =>
    check(typeOf(value) === type, message, () => `expected type ${type}`, typeOf(value), type),
  instanceOf: (value, constructor, message) =>
    check(
      value instanceof constructor,
      message,
      () => `expected ${describeValue(value)} to be an instance of ${constructor.name}`,
    ),
};

// ---------------------------------------------------------------------------
// vitest `expect` subset

class StringContaining {
  constructor(readonly expected: string) {}
  matches(value: unknown): boolean {
    return typeof value === "string" && value.includes(this.expected);
  }
  [inspect.custom]() {
    return `StringContaining ${JSON.stringify(this.expected)}`;
  }
}

// vitest's toMatchObject: every expected field matches recursively; arrays must
// match element for element; asymmetric matchers test the actual value.
const matchesObject = (actual: unknown, expected: unknown): boolean => {
  if (expected instanceof StringContaining) return expected.matches(actual);
  if (Array.isArray(expected)) {
    return (
      Array.isArray(actual) &&
      actual.length === expected.length &&
      expected.every((item, index) => matchesObject(actual[index], item))
    );
  }
  if (expected !== null && typeof expected === "object" && !(expected instanceof Date)) {
    if (actual === null || typeof actual !== "object") return false;
    return enumerableKeys(expected).every(
      (key) =>
        key in actual &&
        matchesObject(
          (actual as Record<PropertyKey, unknown>)[key],
          (expected as Record<PropertyKey, unknown>)[key],
        ),
    );
  }
  return deepEqual(actual, expected);
};

const contains = (actual: unknown, item: unknown): boolean => {
  if (typeof actual === "string") return typeof item === "string" && actual.includes(item);
  if (Array.isArray(actual)) return actual.includes(item);
  if (actual instanceof Set) return actual.has(item);
  return fail(`toContain needs a string, array or Set, got ${describeValue(actual)}`);
};

interface Matchers {
  toBe(expected: unknown): void;
  toEqual(expected: unknown): void;
  toContain(item: unknown): void;
  toBeGreaterThan(expected: number | bigint): void;
  toMatchObject(expected: object): void;
}

const makeMatchers = (actual: unknown, negated: boolean): Matchers => {
  const verify = (ok: boolean, detail: string, expected?: unknown, operator?: string) => {
    if (ok === negated) {
      fail(`expected ${describeValue(actual)} ${negated ? "not " : ""}${detail}`, actual, expected, operator);
    }
  };
  return {
    toBe: (expected) => verify(Object.is(actual, expected), `to be ${describeValue(expected)}`, expected, "toBe"),
    toEqual: (expected) =>
      verify(deepEqual(actual, expected, true), `to equal ${describeValue(expected)}`, expected, "toEqual"),
    toContain: (item) => verify(contains(actual, item), `to contain ${describeValue(item)}`),
    toBeGreaterThan: (expected) =>
      verify((actual as number | bigint) > expected, `to be greater than ${expected}`),
    toMatchObject: (expected) =>
      verify(matchesObject(actual, expected), `to match object ${describeValue(expected)}`, expected, "toMatchObject"),
  };
};

export const expect = Object.assign(
  (actual: unknown): Matchers & { readonly not: Matchers } =>
    Object.assign(makeMatchers(actual, false), { not: makeMatchers(actual, true) }),
  {
    stringContaining: (expected: string): any => new StringContaining(expected),
  },
);
