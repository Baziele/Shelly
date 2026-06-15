# ADR 0007: Session Persistence and Error Handling

## Status
Accepted

## Context
Shelly captures session context and may run into failures when calling the LLM, parsing responses, or detecting command boundaries. We need a default policy for persistence and errors.

## Decision
- **Persistence:** Session context is kept **in memory only** for v1. No command history, conversation logs, or output context is persisted to disk. This protects privacy and keeps the architecture simple.
- **Error handling:** When something fails (LLM unreachable, malformed JSON, missing shell hooks, tool error), Shelly prints a concise inline error above the prompt and returns control to the User Shell. For missing hooks, it degrades gracefully to prompt-pattern detection rather than refusing to work.

## Consequences
- Users cannot resume a previous Session or review past conversations after closing the terminal.
- Failures are visible but non-blocking; the user can continue using their shell.
- Privacy is preserved by default, at the cost of long-term memory.
