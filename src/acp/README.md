# src/acp: vendored effect-acp

An Effect-native client (and agent) for the [Agent Client Protocol](https://agentclientprotocol.com)
over JSON-RPC on stdio. It is T3 Code's `packages/effect-acp`, vendored so the Shelly daemon can drive
Claude Code (through `@agentclientprotocol/claude-agent-acp`) and OpenCode (`opencode acp`). Its only
runtime dependency is `effect` (4.1.6). `@effect/platform-node` supplies the process spawner.

- Upstream: github.com/pingdotgg/t3code, `packages/effect-acp`
- Pinned commit: `6696eefe21103dcf353659c2fc69815f62faf3cb`
- License: MIT, Copyright (c) 2026 T3 Tools Inc. (see `LICENSE`). Each copied file has a header naming
  its upstream path.

## Layout

| Here | Upstream (`packages/effect-acp/`) |
| --- | --- |
| `client.ts`, `agent.ts`, `protocol.ts`, `rpc.ts`, `errors.ts`, `schema.ts`, `compat.ts` | `src/*.ts` |
| `_internal/`, `_generated/` | `src/_internal/`, `src/_generated/` |
| `*.test.ts`, `_internal/*.test.ts` | `src/*.test.ts`, `src/_internal/*.test.ts` |
| `test/fixtures/` (mock peer, Antigravity initialize fixture) | `test/fixtures/` |
| `scripts/generate.ts` | `scripts/generate.ts` |
| `test/effect-vitest.ts`, `real-agents.test.ts`, `scripts/resync.ts`, this README | Shelly only |

Upstream's `package.json` and `tsconfig.json` are T3 tooling and are not copied. Import modules by
path: `./client.js` (the client), `./compat.js` (the payload types the client speaks), `./errors.js`,
`./schema.js` (v2 wire schemas), `./_generated/schema-v1.gen.js` (v1 wire schemas).

## What we changed

The first commit on the branch that added this directory is a verbatim copy. Later commits hold
every change:

- Relative import specifiers end in `.js` instead of `.ts`. Shelly's tsconfig doesn't set
  `allowImportingTsExtensions`. Nothing else in the library sources needed changing to pass our
  strict flags under TypeScript 7.
- The tests run on node:test. `test/effect-vitest.ts` implements the part of `@effect/vitest` they
  use: `it.effect` (scoped, with TestClock and TestConsole), `it.effect.each`, `it.layer`,
  `describe`, and the chai `assert` / vitest `expect` matchers they call. The test files change only
  their import line and keep every assertion. One difference: `it.layer` builds its layer once per
  test rather than once per block.
- Tests find the fixtures at `./test/fixtures/`. They spawn the mock peer with `--import tsx`, since
  its imports now end in `.js`.
- `client.test.ts` annotates one elicitation response as `CreateElicitationResponse`. Upstream
  infers that type only under `exactOptionalPropertyTypes`, which Shelly doesn't enable.
- `scripts/generate.ts` writes to `src/acp/_generated`. It formats with
  `pnpm --package=vite-plus@1.8.0 dlx vp fmt` instead of `pnpm exec vp fmt`. Shelly's tsconfig
  excludes it, because it needs `@effect/openapi-generator`.
- Not carried over: T3's pnpm patch to `@effect/platform-node-shared`. It changes Windows `taskkill`
  and the proxy-process timeout, and effect-acp doesn't depend on it. Effect 4.1.6 itself needed no
  adaptation.

## Re-syncing

```sh
git -C /path/to/t3code log --oneline 6696eefe..HEAD -- packages/effect-acp   # what changed
node src/acp/scripts/resync.ts /path/to/t3code
git diff                                                                     # upstream's change
pnpm typecheck && pnpm test
```

`resync.ts` copies upstream over this directory and redoes every mechanical adaptation listed above.
At the pinned commit, it leaves the tree unchanged. If upstream rewrites a line the script edits,
the edit no longer applies, and typecheck or the tests will fail on that line. After a re-sync,
update the pinned commit here. Also update `test/effect-vitest.ts` if the tests start using more
of `@effect/vitest`.

### Regenerating the schemas

Re-syncing copies upstream's committed `_generated/` files, and that is the normal way to update
them. Running the generator yourself is possible:

```sh
pnpm add -D @effect/openapi-generator@4.1.6     # temporary, don't commit
node --import tsx src/acp/scripts/generate.ts   # downloads the pinned ACP schema releases
```

At the pinned commit, its output differs from upstream's committed files, in content as well as
formatting. Upstream's committed files came from an earlier version of the generator, so prefer
copying them.

## Using the client (for the daemon)

Everything is an `Effect`. A client lives in a `Scope`, and closing that scope ends the connection
and kills the agent process.

### Spawn an agent and get a typed client

```ts
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as AcpClient from "./acp/client.js";

const session = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  // Claude: process.execPath + the claude-agent-acp bin
  // (node_modules/@agentclientprotocol/claude-agent-acp, bin "claude-agent-acp" -> dist/index.js).
  const child = yield* spawner.spawn(ChildProcess.make("opencode", ["acp"], { cwd }));

  // effect-acp never reads stderr. Drain it (keep a tail for diagnostics) or the agent
  // blocks once the pipe fills.
  yield* child.stderr.pipe(
    Stream.decodeText(),
    Stream.runForEach((text) => Effect.logDebug(text)),
    Effect.ignore,
    Effect.forkScoped,
  );

  const context = yield* Layer.build(AcpClient.layerChildProcess(child, { onTermination }));
  const acp = Context.get(context, AcpClient.AcpClient);
  // ... register handlers, then initialize
}).pipe(Effect.scoped, Effect.provide(NodeServices.layer));
```

You can also `Effect.provide(AcpClient.layerChildProcess(child))` and `yield* AcpClient.AcpClient`.
`AcpClient.make(stdio, options)` takes any `AcpStdio`, which helps with in-memory tests (see
`_internal/stdio.ts` `makeInMemoryStdio`). Options cover protocol logging (`logIncoming`,
`logOutgoing`, `logger`) and hooks: `onTermination`, `onIncomingRequest`,
`onUndecodableNotification`, `transformStdout` (for agents that print non-JSON on stdout) and
`transformSessionUpdate`.

### Agent methods (`acp.agent.*`)

Each returns `Effect<Response, AcpError>`. The types are in `./compat.js`, one shape for both
protocol generations.

- `initialize({ protocolVersion: 2, clientInfo: { name: "shelly", version }, clientCapabilities: { fs: { readTextFile, writeTextFile }, terminal } })`.
  Pass `clientInfo`, or the agent sees `t3-code`. The `clientCapabilities` you advertise here decide
  which requests the agent sends you.
- `createSession({ cwd, mcpServers: [] })` → `{ sessionId, modes?, models?, configOptions? }` (`session/new`).
- `loadSession({ sessionId, cwd, mcpServers })` → `session/load` on v1. On v2 it sends
  `session/resume` with replay from the start, because v2 removed `session/load`. Check
  `agentCapabilities.loadSession` first.
- `resumeSession({ sessionId, cwd, mcpServers, replayFrom? })` → `session/resume`. Check
  `agentCapabilities.sessionCapabilities.resume`.
- `prompt({ sessionId, prompt: [{ type: "text", text }] })` → `{ stopReason, usage? }` once the
  turn ends. On v2, `session/prompt` returns at once, and the client resolves the call when the
  agent's idle `state_update` arrives. A v2 session allows one active prompt at a time. Fork the call
  if you need to cancel it.
- `cancel({ sessionId })` sends the `session/cancel` notification. Per ACP, the agent then ends the
  turn, and the pending `prompt` resolves with `stopReason: "cancelled"`. You must answer any
  pending permission request with the `cancelled` outcome.
- Also available: `authenticate`, `logout`, `listSessions`, `forkSession`, `closeSession`,
  `deleteSession` (fails method-not-found unless the agent advertised it), `setSessionModel` and
  `setSessionMode` (v1 only), `setSessionConfigOption`, and `listProviders`, `setProvider` and
  `disableProvider` (v2 only). Use `acp.raw.request(method, payload)` and
  `acp.raw.notify(method, payload)` for anything else.

### session/update notifications

Register a callback. The library doesn't expose them as a typed Stream:

```ts
yield* acp.handleSessionUpdate((n) => Queue.offer(updates, n).pipe(Effect.asVoid));
const stream = Stream.fromQueue(updates); // build your own Stream if you want one
```

- Updates arrive as `compat.SessionNotification` (`{ sessionId, update }`), normalized to v2
  semantics on either generation. `update.sessionUpdate` is the discriminant (`agent_message_chunk`,
  `tool_call`, `tool_call_update`, `plan`, `state_update`, `notice`, ...). The client keeps unknown
  variants rather than failing on them.
- Updates that arrive before any handler is registered are buffered and replayed to the first
  handler.
- Handlers run inline on the reader fiber, so a slow handler stalls the whole connection. Hand each
  update off to a `Queue` as above. A handler that fails or dies is logged and doesn't stop the
  reader.
- `acp.raw.notifications` is a `Stream` of every inbound notification, but it is lossy: it keeps
  only the newest 32 unread notifications, up to 16Mi characters. Use it for debugging, not as the
  update pipeline.
- `handleElicitationComplete`, `handleExtNotification(method, schema, handler)` and
  `handleUnknownExtNotification` cover the other notifications.

### Agent → client requests

Register one handler per method. Each takes the decoded request and a context
(`{ requestId, method }`) and returns `Effect<Response, AcpError>`:

- `handleRequestPermission`: respond `{ outcome: { outcome: "selected", optionId } }` or
  `{ outcome: { outcome: "cancelled" } }`.
- `handleReadTextFile` → `{ content }`, `handleWriteTextFile` → `{}` (or void).
- `handleCreateTerminal` → `{ terminalId }`, `handleTerminalOutput`, `handleTerminalWaitForExit`,
  `handleTerminalKill`, `handleTerminalRelease`.
- `handleElicitation`, `handleMcpConnect`, `handleMcpMessage`, `handleMcpDisconnect`,
  `handleMcpNotification`, `handleExtRequest(method, schema, handler)`, `handleUnknownExtRequest`.

A method without a handler answers JSON-RPC method-not-found. To send a specific JSON-RPC error,
fail with `AcpError.AcpRequestError` (for example `AcpRequestError.invalidParams(...)` or
`.methodNotFound(...)`). Any other failure becomes an internal error. A defect is logged and
answered as an error, and the connection keeps reading. Register handlers before `initialize`, and
advertise only the capabilities you handle.

### Errors

Every call fails with `AcpError` (`./errors.js`), a tagged union you can match with
`Effect.catchTag`:

- `AcpRequestError`: the agent answered with a JSON-RPC error. Fields: `code`, `errorMessage`,
  `data`.
- `AcpProcessExitedError`: the agent process exited. Fields: `code` or `signal`, `pid`, and
  `stderr` if you fill it.
- `AcpInputStreamEndedError`: stdout closed and no exit status arrived within 250 ms.
- `AcpTransportError`: a stdio read failure or a failed RPC call. Fields: `operation`, `method`,
  `cause`.
- `AcpProtocolParseError`: a message failed to encode or decode. Its diagnostics name the schema
  paths, never the payload values.
- `AcpSpawnError`: the process failed to spawn.

Undecodable notifications are dropped (`onUndecodableNotification` sees them) and don't end the
connection.

### Process exit and stderr

- When the agent's stdout ends, or the process exits, the connection terminates. Every pending
  request and in-flight v2 `prompt` fails with the classified error (usually
  `AcpProcessExitedError`). `onTermination(error)` runs once, and later calls fail at once.
- effect-acp never reads stderr. You must drain `child.stderr` yourself, as shown above. T3 Code
  keeps a tail of it and attaches the tail to `AcpProcessExitedError.stderr`.
- The spawned child belongs to the scope it was spawned in. Closing that scope kills the process.
  Use `child.kill({ forceKillAfter: "1 second" })` for an explicit shutdown.

### v1 vs v2 negotiation (`compat.ts`)

`initialize` always sends one hybrid request that carries both the v2 fields (`info`,
`capabilities`) and the v1 fields (`clientCapabilities`, `clientInfo`). The client then picks the
generation from the response's shape, not its `protocolVersion` number: a response with `info`
is v2, anything else is v1. Antigravity, for example, reports version 2 with a v1 response shape.
From then on, each `acp.agent.*` method maps to the right wire method and payload for that
generation. Responses and session updates are normalized into the `compat.ts` types, which follow
v1 field names (`agentCapabilities`, `agentInfo`) and v2 semantics. Methods that one generation
lacks fail with method-not-found. Measured on 2026-11-27:

- claude-agent-acp 0.113.0 speaks v2 on the wire (`protocolVersion: 2`, `info`, `capabilities`).
- opencode 2.4.1 speaks v1 (`protocolVersion: 1`, `agentCapabilities`).

## Tests

- `pnpm test` runs the ported upstream tests (89) with everything else.
- `SHELLY_REAL_AGENTS=1 node --import tsx --test src/acp/real-agents.test.ts` runs only
  `initialize` against the real claude-agent-acp and, if it's on PATH, `opencode acp`. Initialize
  costs no tokens, and the test creates no session.

## Startup cost

The client entry and its generated schemas (about 900 KB of TypeScript) build every schema at import.
On an Apple M1 Pro under heavy load, bundled with esbuild as `pnpm build` would ship it, importing
`client.ts` took a median of about 77 ms (48 ms at best). The same bundling of `effect/Effect`,
`Schema`, `Stream` and `RpcClient` alone took about 51 ms (33 ms at best). So effect-acp adds
roughly 15 to 25 ms on top of Effect. Under tsx in development, the first import takes 0.5 to 1.5 s,
because tsx transpiles the generated files. If that matters, import the client lazily, when the
daemon first needs an agent.
