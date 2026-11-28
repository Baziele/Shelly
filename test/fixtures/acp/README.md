# ACP protocol fixtures

Recorded JSON-RPC traffic between a client and two real ACP agents:

- `claude/`: `@agentclientprotocol/claude-agent-acp` 0.113.0, which runs the
  Claude Code CLI that its SDK bundles (`@anthropic-ai/claude-agent-sdk` 0.3.331),
  on the `haiku` model.
- `opencode/`: `opencode acp` from OpenCode 2.4.1, on `opencode-go/hy4-flash-free`.

Two recorders:

- `scripts/acp-probe.ts` speaks plain ACP v1 (`protocolVersion: 1`). Most
  fixtures come from it.
- `scripts/acp-record.ts` drives Shelly's own `AgentRuntime` and records what its
  client exchanges: the `shelly-*` fixtures. Shelly's client sends a hybrid
  `initialize` that negotiates **ACP v2 with Claude Code** (v1 with OpenCode), so
  these are what Shelly really sees from Claude: v2 diffs (`changes` plus a git
  `patch`), terminal output in `terminal_update` session updates (base64), and a
  turn that ends with a `state_update` (`idle`, `stopReason`, `error`) instead of
  a prompt response. Its session runs in one folder with the project as an
  additional directory, like a thread in Shelly's home.

## Format

One JSON-RPC message per line:

```json
{"dir":"out","t":420.6,"msg":{"jsonrpc":"2.0","id":1,"method":"session/new","params":{}}}
```

- `dir`: `out` is client → agent, `in` is agent → client.
- `t`: milliseconds since the probe started, so differences between lines are
  real latencies.
- `proc`: only in `resume.ndjson`, the agent process (1, 2 or 3) that the line
  belongs to. Each new process starts with an `initialize` request.
- `trimmed`: present when a long list (slash commands, models, modes) was
  shortened to its first 8 entries. The list's shape is unchanged.

## Sanitizing

The recorder rewrites the probe directory to `/tmp/probe` (and the
`external` scenario's other directories to `/tmp/extra` and `/tmp/outside`),
the OS temp directory to `/tmp`, the home directory to `/home/user`, and the
username and machine name to `user` and `host`. It also replaces email
addresses with `user@example.com`, replaces anything token-like with `<token>`,
and replaces the values of keys such as `email`, `organization` and `token`
with `<redacted>`. Streamed text chunks are joined per message before
scrubbing, so a path split across chunks is caught too. Session ids,
tool-call ids and message ids are random and kept.

## Fixtures

| Fixture | What it shows |
| --- | --- |
| `claude/shelly-write` | Through Shelly's client (v2): a Write of a new file in the additional directory, in Claude's default mode (Auto here, so no permission prompt). The content is a v2 `diff`: `changes: [{operation: "add"}]` and a git patch. |
| `claude/shelly-bash` | Through Shelly's client (v2): the `bash` command. The tool's content names a `terminal`; the output (with CRLF line ends) and `exitStatus` come in `terminal_update` session updates, some before the tool call. |
| `claude/shelly-signed-out` | Through Shelly's client (v2), signed out: `session/new` succeeds, `auth/status_update` says `unauthenticated`, and the turn ends with `state_update` idle, `stopReason: "error"`, `error: {code: -32000}`. |
| `init` | `initialize` and `session/new` with `fs` client capabilities, then the notifications that follow setup (`available_commands_update`; for Claude also `_auth/status_update` and `auth/status_update`). |
| `claude/init-caps-none` | The same with no client capabilities. claude-agent-acp answers `initialize` identically. |
| `init-lean` | Claude: `session/new` with tools, settings and MCP off, a `systemPrompt` override and haiku. OpenCode: selecting the `shelly-fast` agent defined in the probe directory's `opencode.json`. |
| `simple` | A one-word answer: `agent_message_chunk`, `usage_update`, then `stopReason: "end_turn"`. Claude often also sends a generated title as `session_info_update`, at any point in the turn (see `tool`); this recording has none. |
| `simple-lean` | The same turn through the lean setup. |
| `tool` | A read tool call: `tool_call` (pending), `tool_call_update` (in_progress, then completed with content). Neither agent calls the client's `fs/*` methods. |
| `bash-caps-shelly` | A shell command (`printf` three lines, `echo` to stderr, `exit 3`), with the client capabilities the daemon sends (`--caps shelly`: `_meta.terminal_output_delta`). Claude reports the output in the tool call's `_meta` (`terminal_info`, `terminal_output_delta`, `terminal_exit` with the exit code) and leaves only a `terminal` placeholder in its content. OpenCode ignores the capability and sends the output and "Exit code: 3" as text content. Claude's run uses the user's own `claude` (`--claude-exe`), as Shelly does. |
| `claude/bash-caps-none` | The same command without the capability: Claude sends the command's description as text, then the output as a fenced code block in the final update only. |
| `permission-allow` | `session/request_permission`, answered with the `allow_once` option. Claude's session runs in the `default` (Manual) mode, and OpenCode's probe config sets `edit: "ask"`. |
| `permission-reject` | The same, answered with `reject_once`. Claude ends the turn with `end_turn` and says why. OpenCode ends it at once with `stopReason: "cancelled"`. |
| `external` | `additionalDirectories` on `session/new`: a read in the added directory needs no permission; a read outside the workspace asks. OpenCode's probe config sets `external_directory: "ask"` for this, since its default allows everything. |
| `cancel` | `session/cancel` while numbers stream: the prompt answers `stopReason: "cancelled"` within about 15 ms, and a later prompt works. |
| `resume` | Process 1 runs one turn and is killed with SIGKILL. Process 2 calls `session/load`, which replays the history as `user_message_chunk` and `agent_message_chunk` notifications. Process 3 calls `session/resume`, which replays nothing. Both remember the conversation. It ends with `session/close`. |

## Re-recording

```sh
node --import tsx scripts/acp-record.ts --agent claude --scenario write        # one haiku prompt
node --import tsx scripts/acp-record.ts --agent claude --scenario bash         # one haiku prompt
node --import tsx scripts/acp-record.ts --agent claude --scenario signed-out   # no model call
```

`signed-out` points HOME and CLAUDE_CONFIG_DIR at an empty folder, so Claude Code
refuses the prompt before calling a model. The sanitizer (`scripts/acp-sanitize.ts`,
shared by both recorders) also decodes v2's base64 terminal output to scrub it.

Every scenario except `init` sends one to three tiny prompts to a small model,
which costs a little.

```sh
node --import tsx scripts/acp-probe.ts --agent claude --scenario simple
node --import tsx scripts/acp-probe.ts --agent opencode --scenario permission-reject
node --import tsx scripts/acp-probe.ts --agent claude --scenario simple --lean
node --import tsx scripts/acp-probe.ts --agent claude --scenario init --caps none
node --import tsx scripts/acp-probe.ts --agent claude --scenario bash --caps shelly --claude-exe "$(command -v claude)"
```

The scenarios are `init`, `simple`, `tool`, `bash`, `write`, `permission-allow`,
`permission-reject`, `external`, `cancel` and `resume`. `latency` and `rss`
print measurements without writing a fixture. Each run prints a JSON report
on stdout and writes `test/fixtures/acp/<agent>/<scenario>[-lean][-caps-<caps>].ndjson`.
`--no-record` skips the fixture, `--verbose` prints the traffic as it passes,
and `--resanitize` runs the current sanitizer over the recorded files again.

Each run uses a new directory from `mktemp` that is deleted afterwards. Claude
sessions are started with `persistSession: false`, except in `resume`, so most
leave no transcript (Claude Code still creates an empty project directory for
each one under `~/.claude/projects`). OpenCode keeps every session in its own
database.

Before committing a re-recorded fixture, check it for anything personal, for
example with `grep -ri "$USER" test/fixtures/acp`.
