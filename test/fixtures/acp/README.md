# ACP protocol fixtures

Recorded JSON-RPC traffic between a client and two real ACP agents:

- `claude/`: `@agentclientprotocol/claude-agent-acp` 0.113.0, which runs the
  Claude Code CLI that its SDK bundles (`@anthropic-ai/claude-agent-sdk` 0.3.331),
  on the `haiku` model.
- `opencode/`: `opencode acp` from OpenCode 2.4.1, on `opencode-go/hy4-flash-free`.

All of them come from `scripts/acp-probe.ts`, speaking ACP v1
(`protocolVersion: 1`).

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
| `init` | `initialize` and `session/new` with `fs` client capabilities, then the notifications that follow setup (`available_commands_update`; for Claude also `_auth/status_update` and `auth/status_update`). |
| `claude/init-caps-none` | The same with no client capabilities. claude-agent-acp answers `initialize` identically. |
| `init-lean` | Claude: `session/new` with tools, settings and MCP off, a `systemPrompt` override and haiku. OpenCode: selecting the `shelly-fast` agent defined in the probe directory's `opencode.json`. |
| `simple` | A one-word answer: `agent_message_chunk`, `usage_update`, then `stopReason: "end_turn"`. Claude often also sends a generated title as `session_info_update`, at any point in the turn (see `tool`); this recording has none. |
| `simple-lean` | The same turn through the lean setup. |
| `tool` | A read tool call: `tool_call` (pending), `tool_call_update` (in_progress, then completed with content). Neither agent calls the client's `fs/*` methods. |
| `permission-allow` | `session/request_permission`, answered with the `allow_once` option. Claude's session runs in the `default` (Manual) mode, and OpenCode's probe config sets `edit: "ask"`. |
| `permission-reject` | The same, answered with `reject_once`. Claude ends the turn with `end_turn` and says why. OpenCode ends it at once with `stopReason: "cancelled"`. |
| `external` | `additionalDirectories` on `session/new`: a read in the added directory needs no permission; a read outside the workspace asks. OpenCode's probe config sets `external_directory: "ask"` for this, since its default allows everything. |
| `cancel` | `session/cancel` while numbers stream: the prompt answers `stopReason: "cancelled"` within about 15 ms, and a later prompt works. |
| `resume` | Process 1 runs one turn and is killed with SIGKILL. Process 2 calls `session/load`, which replays the history as `user_message_chunk` and `agent_message_chunk` notifications. Process 3 calls `session/resume`, which replays nothing. Both remember the conversation. It ends with `session/close`. |

## Re-recording

Every scenario except `init` sends one to three tiny prompts to a small model,
which costs a little.

```sh
node --import tsx scripts/acp-probe.ts --agent claude --scenario simple
node --import tsx scripts/acp-probe.ts --agent opencode --scenario permission-reject
node --import tsx scripts/acp-probe.ts --agent claude --scenario simple --lean
node --import tsx scripts/acp-probe.ts --agent claude --scenario init --caps none
```

The scenarios are `init`, `simple`, `tool`, `permission-allow`,
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
