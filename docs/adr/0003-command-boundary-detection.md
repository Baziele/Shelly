# ADR 0003: Command Boundary Detection via Shell Hooks

## Status
Accepted

## Context
Shelly needs to build Command History and Output Context by knowing when a command starts, when it ends, and what exit code it returned. The User Shell is running behind a PTY that Shelly proxies, so raw output alone does not clearly delimit commands.

## Decision
Use **shell integration hooks** to mark command boundaries and report exit codes:
- Bash: `PROMPT_COMMAND`
- Zsh: `precmd`
- Fish: equivalent post-command hook (future)

Bash and zsh are supported first. The hook is auto-injected when Shelly spawns the User Shell, with an opt-out for users who prefer manual configuration. The hook emits an invisible marker that Shelly can parse from the PTY output. For unsupported shells, Shelly falls back to prompt-pattern heuristics, but exit-code capture may be less reliable.

## Consequences
- Accurate Command History and Output Context for supported shells.
- Requires installing/configuring a small shell hook per supported shell.
- Unsupported shells get degraded context capture.
