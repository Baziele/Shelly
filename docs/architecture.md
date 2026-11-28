# Shelly architecture

Shelly lives inside the user's terminal. It proxies their shell untouched,
records what they run, and lets them hand a question or a task to a coding
agent they already have (Claude Code, OpenCode, any ACP agent) without
leaving the shell. Shelly ships no agent of its own.

This page records the decisions that span components and the reasons for
them. The code holds the details.

## Processes

```
terminal tab ─ shelly (client) ─ pty ─ user's shell (with Shelly's hooks)
                   │
                   └─ unix socket ─ shelly daemon (Effect v4)
                                      ├─ ACP agent processes (agent mode)
                                      ├─ warm fast-path workers (fast mode)
                                      └─ store: threads and their events (SQLite)
```

- **Client** (`src/shelly.ts` and friends): one per terminal tab. Owns the pty,
  the shell hooks, the command log, the inline UI, and everything the user
  sees. Plain TypeScript on the hot path; it loads the daemon connection and
  the UI lazily, after the shell is up, so Shelly never delays the prompt.
- **Daemon** (`src/daemon/`): one per user, started on demand by the first
  client that needs it and gone after a while with no clients and no running
  turns. Owns agent processes, threads and their history, so a thread outlives
  the tab it started in and an agent's work survives closing the tab.
- **Protocol** (`src/protocol/`): Effect RPC over a unix socket in
  `$SHELLY_HOME/run/`, NDJSON-serialised. Both sides share the schemas.

`SHELLY_HOME` defaults to `~/.shelly`. Tests always point it at a temporary
directory.

## Two modes

The input opens on `::` or `__` typed at an empty prompt, and on a hotkey that
also captures a half-typed command.

| | Agent mode | Fast mode |
|---|---|---|
| For | Questions that need looking around, and tasks the agent carries out | Writing or rewriting one command; one-line answers |
| Runs | A full ACP agent turn: tools, permissions, plans | One request to a warm, stripped-down model process: no tools, no MCP, no settings |
| Kept | In a thread, resumable | Not kept |
| Output | Streamed inline: markdown, tool calls, diffs, permission prompts | A command placed on the shell's input line, or a short answer |
| Target | First feedback at once; agent start hidden by warming it while the user types | First token in about 0.7 s |

Fast mode is deliberately not a small agent turn. Starting an agent, loading
its tools and sending its long system prompt costs seconds; fast mode keeps
a lean process warm and pays only for the model. T3 Code splits its providers
the same way (an agent adapter and a separate text-generation path).
For Claude Code the lean process is `claude -p` with everything turned off;
for OpenCode it is a session on OpenCode's own background service (its HTTP
API), run by a no-tools agent defined in Shelly's fast-mode folder.

## Agents over ACP

Agent mode speaks the Agent Client Protocol to every agent, through the Effect
ACP client in `src/acp/` (adapted from T3 Code, MIT). Claude Code runs through
`@agentclientprotocol/claude-agent-acp`, OpenCode through `opencode acp`, and
any other ACP agent can be added in `$SHELLY_HOME/config.json`. A native
adapter is only for a gap ACP cannot cover.

Shelly reads capabilities, never agent names, outside the agent definitions:
whether an agent can resume or load a session, close one, or switch modes.
It never fakes a permission mode an agent does not enforce, and passes the
agent's own permission options through unchanged.

## Threads

- A thread is Shelly's record of one conversation with one agent: its id,
  title, agent, working directory and the agent's own session id. The agent
  keeps the transcript; resuming means asking the agent to resume or load its
  session.
- Each terminal has at most one current thread. `::` continues it; `/new`
  starts another; `/threads` and `/switch` reattach an old one. Only one
  terminal drives a thread at a time.
- By default a thread runs in Shelly's own folder (`$SHELLY_HOME/home`), so
  agent sessions do not pile up in the user's projects, and is told where the
  user's shell is and given access to it. `/here` starts a thread rooted in
  the current folder instead. Where a thread lives is fixed when it starts.
- The daemon keeps a thread's events (the same events clients render) so a
  terminal that switches to it can show the last exchange, and a terminal that
  reattaches mid-turn can catch up from a sequence number.
- Idle agent sessions are released after a few minutes and resumed on the next
  message. On startup the daemon marks turns it lost as interrupted.

## Context

The client records each command, its exit code, directory, duration and
output (`src/context/`). The first message of a thread carries the recent
commands in full within a budget; follow-ups carry only what ran since the
agent last heard. Fast mode carries the line being edited, the directory, and
the last command or two. Secrets are masked before anything leaves the client,
and commands typed with a leading space are never recorded.

## The shell's input line

Fast mode reads the line being edited and leaves its answer on the shell's
own input line, ready to edit or run, never run for the user
(`src/shell/line-editor.ts`). Shelly sends the shell private keys no terminal
sends (F12 down to F8 with every modifier held, the one kind of key that
zle, readline and fish 4 can all bind), and the hooks bind them in every
keymap (emacs and vi):

- **capture**: the hooks report the line and cursor with a `line` marker and
  clear the line, so Shelly can draw there.
- **set**: Shelly writes the text to a file and the hooks put it on the line
  verbatim, then delete the file. Text never travels as keystrokes, so quotes,
  `$`, `!`, tabs and newlines mean nothing to the line editor. The file sits in
  a 0700 directory with a fresh random name per session, and exists only
  until the shell reads it.
- **notice**: the hooks show a one-line message from the file below the line,
  leaving the line alone.

Each request is numbered in the file and the hooks echo the number, so a late
answer is never taken for a newer request's. A capture can fail even where it
is supported: the line is too long to report (the shell leaves it alone), or
the shell does not answer in time (when it does, it has cleared the line, and
Shelly puts it back). The rewrite hotkey then leaves the line with the shell
and has it show a notice, rather than opening Shelly's input.

| Shell | Capture | Replace |
|---|---|---|
| zsh, fish 4, bash 4+ | yes | set exactly, multi-line included |
| bash 3.2 (macOS) | no (no `READLINE_LINE`) | clear the line and type: a bracketed paste if the shell turned it on, else one line, control characters removed |

Shelly takes these keys out of what the user types at the prompt, and only
sends them while the shell is at its prompt (after `cwd`, before `exec`,
with nothing else in the foreground). The rewrite hotkey, Ctrl+], works the
same way: at the prompt, Shelly takes it and captures the line; anywhere
else, it reaches the program untouched.

### Giving the prompt back

After Shelly prints below the prompt (a turn, an answer), the cursor sits
at the start of an empty line, while the shell's line editor still thinks
it is at the end of its prompt further up. Enter on the empty line makes
every shell move down one line from where it thinks it is and draw a new
prompt. Everything the shell writes before that prompt's `cwd` marker
(its newline, a late repaint of the old prompt, as fish 3 does after a
resize) is drawn relative to the old position, so Shelly drops it, and the
prompt lands on the empty line right under the output, however late the
rest comes. Output the idle shell made while Shelly drew is dropped for the
same reason. A shell without hooks has no marker: the cursor goes up onto
the last printed line first, so the shell's newline brings it back down.
Keys typed meanwhile and a line to put back wait until the prompt is
drawn: sent sooner, the terminal driver would echo them. Only printable
text is replayed (a stale Enter or arrow must not act on the next
command); Ctrl-C reaches the shell at once.

Shelly never keeps the terminal: every flow that takes it gives it back
when it fails, and if Shelly is busy for a few seconds with nothing on
screen, a watchdog gives the prompt back with a one-line notice.

## Rendering

Agent output is drawn inline on the main screen, never on the alternate
screen: finished output becomes ordinary terminal scrollback, like any
command's output, while a small live region at the bottom repaints in place
(the streaming paragraph, running tool calls, a permission prompt, the status
line). OpenTUI lays out and styles everything in memory, including streaming
markdown, code and diffs; Shelly decides where it lands on screen.

An item moves to scrollback once it and everything before it are final, so
nothing already in scrollback ever needs to change. A long streamed answer
moves there a markdown block at a time while the rest still streams.

The pieces, in `src/ui/` and `src/render/`: `AgentView` (a running turn),
`renderHistory` (a past exchange, printed statically), `PromptView` with its
`ListPicker` (the input, fast-mode progress, slash commands and pickers), and
`LiveRegion` (committed rows plus the repainting region). `pnpm demo` plays
recorded event sequences from `test/fixtures/thread-events/` through them.

## Speed

- Nothing slows the shell: no extra work before the prompt, none per keystroke
  or per byte of output beyond what the hooks need.
- Heavy modules (Effect, OpenTUI, the daemon connection) load after the shell
  starts. The daemon is started at the first prompt; its connection (Effect,
  about 120 ms of synchronous module loading) loads once the terminal has
  been quiet for 300 ms. That is best effort: a key pressed during the load
  waits for it. Without a daemon, Shelly is a plain shell and `::` says why.
- The daemon starts in the background when a client first runs, warms the
  agent while the user is still typing, and keeps one lean fast-mode process
  warm only for a few minutes after use (each costs about 200 MB).
- Rendering coalesces streamed text into frames and repaints only rows that
  changed.
