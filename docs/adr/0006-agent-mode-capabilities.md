# ADR 0006: Agent Mode Capabilities and Security Model

## Status
Accepted

## Context
Agent Mode (`:: `) is meant to be a fully featured agentic workflow inside a terminal session. We need to decide what tools it has and what security boundaries apply.

## Decision
Agent Mode is a **full-capability agent** with access to:

- Read files
- Execute arbitrary shell commands through the User Shell
- Edit files
- Search online

There is **no sandbox or allowlist** for v1. The agent runs with the user’s own permissions, and commands execute as if the user typed them. The user can interrupt execution with Ctrl+C. This is the same trust model as Auto Command, extended across a multi-step conversation.

## Consequences
- Agent Mode can perform complex development tasks end-to-end.
- A mistaken or malicious agent can cause significant damage (delete files, exfiltrate data, run arbitrary network requests).
- This trust model is simple to implement but may need guardrails, confirmation gates, or a sandbox in future versions.
