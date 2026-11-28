# src/daemon/agents: agent mode over ACP

`AgentRuntime` (from `../services.ts`), built on the vendored ACP client in `src/acp/`.

```ts
import * as AgentRuntimeAcp from './agents/runtime.js';

// Needs ShellyConfig and a ChildProcessSpawner (NodeServices.layer from @effect/platform-node).
const agents = AgentRuntimeAcp.layer;
```

| File | What it holds |
| --- | --- |
| `definitions.ts` | The built-in `claude` and `opencode`, custom agents from config.json, passive availability, env hygiene, per-agent quirks and timeouts |
| `process.ts` | One ACP process: spawn, stderr tail, initialize, routing updates and permission requests to sessions |
| `runtime.ts` | The service: processes per agent, a live session per thread, turns, idle release, prewarm |
| `mapping.ts` | Pure ACP → `AgentUpdate` translation, tool-call merging, truncation, modes |
| `testing/` | The fake agent with quirks (`quirk-agent.ts`), a fixture replay peer, scenarios, the test harness |

## Behaviour

- **One process per agent**, shared by its sessions. It starts in its own process group, with the
  daemon's env minus a host Claude Code session's variables (`CLAUDECODE`, `CLAUDE_CODE_SESSION_ID`, …;
  the list in `../claude-env.ts`, shared with fast mode). Claude Code runs the bundled `claude-agent-acp`
  with `CLAUDE_CODE_EXECUTABLE` set to the user's own `claude`: an inherited value if it names a real
  executable, else the first on PATH, else `~/.local/bin` or `~/.claude/local`. stderr is always
  drained into an 8 KB tail that is logged only at debug level. Stopping a process sends its group
  SIGTERM, then SIGKILL after 3 s, outside the agent's lock, so a hung agent never blocks the next one.
- **Sessions.** `session()` returns the thread's live session when the agent, cwd and session id match.
  Otherwise it resumes `nativeSessionId` with `session/resume` (or `session/load` for agents without
  resume), and starts a new session if the agent doesn't know it (`startedFresh: true`). Changed
  `additionalDirectories` re-resume the session: in place for Claude Code (claude-agent-acp rebuilds
  a live session whose parameters changed), close-then-resume for others.
- **Release.** A session closes after `sessionIdleMs` without a turn (Claude Code 3 min, others 2),
  and a process exits `processIdleMs` after its last session (Claude Code 5 min, others 2).
  `SHELLY_AGENT_SESSION_IDLE_MS` / `SHELLY_AGENT_PROCESS_IDLE_MS`, or the per-agent
  `SHELLY_<ID>_SESSION_IDLE_MS` / `SHELLY_<ID>_PROCESS_IDLE_MS`, override them. A dead process marks
  its sessions lost; the next `session()` respawns and resumes. A prewarm restarts the countdown of
  the session (or the session-less process) it targets.
- **Session handles stay usable.** An `AgentSession` keeps working after its session was released or
  its process died: `prompt` and `setMode` reopen it first. `nativeSessionId` and `modes` are getters
  that always show the current values. If the reopen had to start fresh, the turn begins with a
  warning notice.
- **Turns.** One at a time per session. Updates that arrive between turns (a title, a mode change)
  are held and emitted at the start of the next turn; `session.modes` is always current. A consumer
  that stops reading the stream cancels the turn.
- **Errors in a turn** end it with `stopReason: 'error'`: a dead process reads "<Agent> stopped
  unexpectedly.", ACP authRequired (-32000) reads the agent's sign-in message, and other agent
  errors read "<Agent> failed: <first line>".
- **Protocol generations.** The vendored client negotiates: Claude Code answers ACP v2, OpenCode v1.
  `mapping.ts` handles both. v2 diffs (`changes` plus a git patch) become ordinary diffs per file
  (a new file has no old text), and a v2 turn that ends with an `error` (Claude Code signed out ends
  so) becomes an `end` with stopReason `error`.
- **Command output.** A command's tool call holds only a `terminal` placeholder; the output comes
  apart from it: in v2 `terminal_update` / `terminal_output_chunk` session updates (base64), or in v1
  the tool call's `_meta` (Shelly advertises `terminal_output_delta`). The tool tracker keeps it per
  terminal and shows it as the tool's last text content: the end of the output, about 8 KB, with
  "Exit code N" last for a failed command. It is untrusted terminal text, passed on raw for clients to
  sanitise, and never logged.
- **Permissions** are passed through unchanged. `respond(requestId, null)` and `cancel` answer with
  ACP's cancelled outcome. Unknown, already-answered or invalid option ids fail with `UnknownRequest`.
- **Modes** come from ACP `modes`, or else from the `mode` config option (OpenCode's agents).
  `setMode` uses `session/set_mode` or `session/set_config_option` to match. Shelly never picks
  a mode itself.

## Configuration

`$SHELLY_HOME/config.json` may set, per agent, `model`: the model agent mode uses, as the agent names it.
Claude Code gets it as `_meta.claudeCode.options.model` on session/new and resume, and as the `model`
config option (so what the session reports matches); OpenCode and custom agents get the `model` config
option. Without it, the agent's own default applies.

```json
{ "agents": { "claude": { "model": "haiku" }, "opencode": { "model": "opencode-go/hy4-flash-free" } } }
```

## Quirks

Each lives in `definitions.ts` as data, never as an id check:

- `rejectEndsTurnCancelled` (OpenCode): rejecting a permission ends the turn with `cancelled`.
  When the user rejected and didn't cancel, the turn reports `end_turn` plus a notice "Rejected: …".
- `resumeReplacesLiveSession` (Claude Code): see directories above.

## Tests

`pnpm test` runs everything here against the fake ACP agent and the recorded fixtures in
`test/fixtures/acp`, without real agents. `SHELLY_REAL_AGENTS=1 node --import tsx --test
src/daemon/agents/real-agents.test.ts` drives the real Claude Code (haiku) and OpenCode (a free
model): four tiny prompts in all.
