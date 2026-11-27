import type { Step } from '../types.js';
import { scenarioOf } from './_shared.js';

export const MARKDOWN = `# Markdown showcase

Shelly should render **bold**, *italic*, ***both***, \`inline code\` and [links](https://example.com/docs) inline.

## Lists

1. First, an ordered item
2. Second, with a nested list:
   - a bullet
   - another, with \`code\`
     - and a third level
3. Third

- [x] a finished task
- [ ] an open task

## Code

\`\`\`ts
export const greet = (name: string): string => {
  // Template literals and braces should survive streaming.
  return \`Hello, \${name}!\`;
};
\`\`\`

## Table

| Command | What it does | Speed |
| :------ | :----------- | ----: |
| \`ls\` | Lists files | fast |
| \`find . -name '*.ts'\` | Finds TypeScript files | slower |

> A blockquote, which can run on
> over more than one line.

---

That is everything. See [the ACP spec](https://agentclientprotocol.com) for more.
`;

export const script: Step[] = [
  { type: 'thought', text: 'The user wants to see every kind of markdown. ', charsPerTick: 16, tickMs: 30 },
  { type: 'message', text: MARKDOWN, charsPerTick: 9, tickMs: 25 },
];

export default scenarioOf('markdown-showcase', script);
