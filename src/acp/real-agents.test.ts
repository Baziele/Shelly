// Shelly-only smoke test, not part of upstream effect-acp.
//
// Spawns the real agents Shelly drives and runs ACP `initialize` against each,
// which costs no tokens. It creates no session and sends no prompt. It only
// runs with SHELLY_REAL_AGENTS=1:
//
//   SHELLY_REAL_AGENTS=1 node --import tsx --test src/acp/real-agents.test.ts

import { accessSync, constants, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { it } from "node:test";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as AcpClient from "./client.js";

const enabled = process.env.SHELLY_REAL_AGENTS === "1";
const skip = enabled ? false : "set SHELLY_REAL_AGENTS=1 to run against real agents";
const STDERR_TAIL = 4096;

const claudeAgentAcpBin = (): string => {
  const require = createRequire(import.meta.url);
  const manifestPath = require.resolve("@agentclientprotocol/claude-agent-acp/package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    readonly bin: Record<string, string>;
  };
  const bin = manifest.bin["claude-agent-acp"];
  if (bin === undefined) throw new Error("claude-agent-acp has no claude-agent-acp bin entry");
  return path.join(path.dirname(manifestPath), bin);
};

const onPath = (command: string): string | undefined => {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (dir === "") continue;
    const candidate = path.join(dir, command);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // not in this directory
    }
  }
  return undefined;
};

const initializeAgent = (command: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(ChildProcess.make(command, args));
    // effect-acp leaves stderr to the caller; drain it so the agent never blocks on it.
    const stderr = yield* Ref.make("");
    yield* child.stderr.pipe(
      Stream.decodeText(),
      Stream.runForEach((chunk) =>
        Ref.update(stderr, (tail) => (tail + chunk).slice(-STDERR_TAIL)),
      ),
      Effect.ignore,
      Effect.forkScoped,
    );
    const context = yield* Layer.build(AcpClient.layerChildProcess(child));
    const acp = Context.get(context, AcpClient.AcpClient);
    const response = yield* acp.agent
      .initialize({
        protocolVersion: 2,
        clientInfo: { name: "shelly-smoke-test", version: "0.0.0" },
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      })
      .pipe(
        Effect.timeout("60 seconds"),
        Effect.tapError(() =>
          Ref.get(stderr).pipe(
            Effect.flatMap((tail) => Effect.logError(`agent stderr tail:\n${tail}`)),
          ),
        ),
      );
    return { pid: child.pid, response };
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

it("initializes claude-agent-acp over ACP", { skip, timeout: 90_000 }, async (t) => {
  const result = await Effect.runPromise(initializeAgent(process.execPath, [claudeAgentAcpBin()]));
  t.diagnostic(`claude-agent-acp initialize: ${JSON.stringify(result.response)}`);
  if (typeof result.response.protocolVersion !== "number") {
    throw new Error("claude-agent-acp returned no protocol version");
  }
});

const opencode = enabled ? onPath("opencode") : undefined;

it(
  "initializes opencode acp over ACP",
  {
    skip: skip || (opencode === undefined ? "opencode is not on PATH" : false),
    timeout: 90_000,
  },
  async (t) => {
    const result = await Effect.runPromise(initializeAgent(opencode!, ["acp"]));
    t.diagnostic(`opencode acp initialize: ${JSON.stringify(result.response)}`);
    if (typeof result.response.protocolVersion !== "number") {
      throw new Error("opencode returned no protocol version");
    }
  },
);
