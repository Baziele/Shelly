# ADR 0001: Auto Command has no guardrails

## Status
Accepted

## Context
Shelly provides three input prefixes:
- `: ` for a Quick Request (one-off help)
- `:: ` for Agent Mode (multi-step agentic workflow)
- `; ` for Auto Command (single command executed automatically)

The Auto Command prefix is intended to be the fastest path from intent to execution. The user explicitly described it as a “yolo mode” and did not want per-command confirmation or safety prompts.

## Decision
Auto Command (`; `) will execute the LLM-returned command automatically, with no confirmation dialog and no safety guardrails.

This is a deliberate short-term choice to prioritize speed and simplicity while the project is being proven out. Guardrails may be added later behind configuration or a different prefix.

## Consequences
- **Risk:** A mistaken or malicious LLM response can execute destructive commands immediately.
- **UX benefit:** The user gets the lowest-friction path from natural language to command execution.
- **Future work:** If guardrails are introduced, they must not break the `; ` contract unless the prefix itself changes, because users will build muscle memory around the current behavior.
