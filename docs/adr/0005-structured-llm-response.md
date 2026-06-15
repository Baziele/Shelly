# ADR 0005: Structured LLM Response Format

## Status
Accepted

## Context
Quick Request and Auto Command need a reliable way for the LLM to return either an explanation or a shell command. Parsing free-form text (e.g., markdown code blocks) is fragile and breaks when the LLM adds extra commentary.

## Decision
For Quick Request and Auto Command, the LLM returns a structured JSON object:

```json
{
  "explanation": "Optional human-readable explanation.",
  "command": "optional shell command to populate or execute"
}
```

- If `command` is present and the mode is Quick Request, Shelly populates the User Shell input line with the command and returns control without executing it.
- If `command` is present and the mode is Auto Command, Shelly executes the command immediately.
- If `command` is absent, only the `explanation` is rendered inline.

Agent Mode uses ADK's native message/tool-call format, not this JSON contract.

## Consequences
- Reliable command extraction for Quick Request and Auto Command.
- The LLM must be instructed to produce valid JSON, which adds a small amount of prompt engineering.
- The contract is easy to extend later with fields like `dangerous` or `requires_confirmation`.
