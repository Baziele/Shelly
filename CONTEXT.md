# Context: Shelly

## Glossary

**Shelly**
The in-terminal AI assistant. It wraps the user's normal shell in a PTY and provides context-aware help and agentic assistance inside the terminal.

**Session**
A single terminal session managed by Shelly. One Session wraps exactly one user shell process.

**User Shell**
The user's normal shell (e.g., bash, zsh, fish) as it would run without Shelly. Shelly spawns the User Shell behind a PTY and proxies all input/output.

**Quick Request**
A one-off, non-agentic question asked during a Session. The response is rendered inline above the prompt. If the response is a shell command, Shelly populates the User Shell input line with that command and hands control back to the user without executing it. Triggered by typing `: ` at the start of a line.

**Agent Mode**
A longer agentic workflow inside a Session where Shelly can take multiple steps, use tools, and modify terminal state. The agent can read files, execute shell commands, edit files, and search online. The first message is sent after typing `:: <message>`. While the agent is running, any further user input is forwarded to the agent as additional instruction. When the agent finishes its task, control returns to the User Shell automatically. The interaction stays inline in the terminal, not in a full-screen view. Triggered by typing `:: ` at the start of a line.

**Auto Command**
A variant of Quick Request where Shelly selects a single shell command and executes it automatically as if the user had typed it themselves. The user can interact with the running command normally, including sending Ctrl+C. Triggered by typing `; ` at the start of a line.

**Static Context**
The always-included metadata about the current environment, such as the operating system, the User Shell, the current working directory, and relevant language runtime versions.

**Command History**
The recent commands executed in the Session, together with their exit codes, retained to help Shelly understand the user's intent and recent path through the terminal.

**Output Context**
The recent command output retained for the LLM. It is bounded by a total size cap and summarized when an individual output exceeds the space available for it.
