# ADR 0002: Tiered Session Context Model

## Status
Accepted

## Context
Shelly needs to give the LLM enough context about the current Session to answer questions and run commands usefully, without sending excessive tokens or retaining sensitive data longer than necessary.

## Decision
Session context is divided into three tiers:

1. **Static Context** — Always included. Small, fixed metadata such as operating system, User Shell, current working directory, and relevant language runtime versions.
2. **Command History** — The last 10 commands executed in the Session, each paired with its exit code. This helps the LLM understand the user’s recent intent and path through the terminal.
3. **Output Context** — Recent command outputs, capped at **6 KB total** per request. Outputs are included from most-recent backward until the budget is exhausted. Any individual output that would exceed its fair share is summarized with **1 KB from the head and 1 KB from the tail**.

All context is kept in memory by default; persistence is a future opt-in feature.

## Consequences
- Token usage and LLM latency are bounded and predictable.
- Older context is naturally forgotten, which protects privacy but may reduce usefulness for long-running tasks.
- The head/tail summarization preserves both the beginning (often setup/error cause) and the end (often final result/error message) of long outputs.
