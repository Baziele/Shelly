# ADR 0004: Inline Terminal UI

## Status
Accepted

## Context
Shelly is a PTY proxy that wraps the User Shell. The user remains at a normal shell prompt, so the UI must feel native to the terminal rather than like a separate application.

## Decision
All Shelly interactions are rendered **inline** in the terminal:

- **Quick Request (`: `)** — The response appears above the prompt. If the response is a shell command, it is written into the User Shell input line and control is returned without executing it.
- **Auto Command (`; `)** — The selected command runs as if the user had typed it themselves, using the normal PTY flow. The user can interact with it normally, including sending Ctrl+C.
- **Agent Mode (`:: `)** — The agentic workflow stays inline, similar to the AI experience in Warp terminal. There is no full-screen overlay and no persistent "agent prompt." The user invokes the agent with `:: <message>`; while the agent runs, further user input is forwarded to the agent as additional instruction. When the agent finishes its task, control returns to the User Shell automatically.

## Consequences
- The terminal session remains the primary interface; no context switch for the user.
- Screen real estate for Agent Mode is limited, so progress and tool output must be compact.
- A completion marker and Ctrl+C cancellation are required so the user knows when an agent run has ended.
- Quick Requests are detected through shell hooks (bash `DEBUG` trap and a zsh `accept-line` widget) rather than by intercepting stdin, so up-arrow recall, paste, and normal line editing all work unchanged.
- Input handling is still more complex for Agent Mode and Auto Command, where Shelly must temporarily manage the input line or command execution while still proxying the PTY.
