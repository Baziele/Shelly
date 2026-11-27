// Adapted from T3 Code's effect-acp (MIT License, see src/acp/LICENSE).
// Upstream: github.com/pingdotgg/t3code, packages/effect-acp/src/_internal/stdio.test.ts (pinned commit in src/acp/README.md).

import { assert, describe, it } from "../test/effect-vitest.js";
import * as Effect from "effect/Effect";
import * as PlatformError from "effect/PlatformError";
import { ChildProcessSpawner } from "effect/process";

import * as AcpError from "../errors.js";
import { makeTerminationError } from "./stdio.js";

describe("ACP child process termination", () => {
  it.effect("retains the process identifier and exact exit-status cause", () =>
    Effect.gen(function* () {
      const rootCause = new Error("private process diagnostics");
      const cause = PlatformError.systemError({
        _tag: "Unknown",
        module: "ChildProcess",
        method: "exitCode",
        cause: rootCause,
      });
      const error = yield* makeTerminationError({
        pid: ChildProcessSpawner.ProcessId(42),
        exitCode: Effect.fail(cause),
      });

      assert.instanceOf(error, AcpError.AcpTransportError);
      assert.equal(error.pid, 42);
      assert.strictEqual(error.cause, cause);
      assert.equal(error.message, "ACP transport operation read-process-exit-status failed.");
      assert.notInclude(error.message, rootCause.message);
    }),
  );
});
