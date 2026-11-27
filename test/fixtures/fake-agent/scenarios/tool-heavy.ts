import type { Step } from '../types.js';
import { scenarioOf } from './_shared.js';

const ROOT = '/workspace/demo';

export const script: Step[] = [
  { type: 'thought', text: 'I should read the entry point, find the failing test, run it, then fix it.', charsPerTick: 20, tickMs: 30 },

  { type: 'tool_call', id: 'read-1', title: 'Read src/greet.ts', kind: 'read', locations: [{ path: `${ROOT}/src/greet.ts` }], delayMs: 200 },
  { type: 'tool_update', id: 'read-1', status: 'in_progress', delayMs: 150 },
  {
    type: 'tool_update', id: 'read-1', status: 'completed', delayMs: 200,
    content: [{ type: 'text', text: "export const greet = (name: string) => {\n  return 'Hello ' + name;\n};\n" }],
  },

  { type: 'tool_call', id: 'search-1', title: "Search for 'greet(' in src", kind: 'search', rawInput: { pattern: 'greet(', path: 'src' }, delayMs: 200 },
  { type: 'tool_update', id: 'search-1', status: 'in_progress', delayMs: 100 },
  {
    type: 'tool_update', id: 'search-1', status: 'completed', delayMs: 250,
    locations: [{ path: `${ROOT}/src/cli.ts`, line: 14 }, { path: `${ROOT}/test/greet.test.ts`, line: 5 }],
    content: [{ type: 'text', text: 'src/cli.ts:14:  console.log(greet(argv[0]));\ntest/greet.test.ts:5:  assert.equal(greet("Ada"), "Hello, Ada!");' }],
  },

  { type: 'tool_call', id: 'exec-1', title: 'Run `pnpm test`', kind: 'execute', rawInput: { command: 'pnpm test' }, delayMs: 200 },
  { type: 'tool_update', id: 'exec-1', status: 'in_progress', delayMs: 100 },
  {
    type: 'tool_update', id: 'exec-1', status: 'completed', delayMs: 900,
    content: [{
      type: 'text',
      text: [
        '> demo@1.0.0 test',
        '> node --test',
        '',
        '✖ greet adds a comma (2.1ms)',
        "  AssertionError: 'Hello Ada' !== 'Hello, Ada!'",
        '      at test/greet.test.ts:5:10',
        'ℹ tests 3',
        'ℹ pass 2',
        'ℹ fail 1',
      ].join('\n'),
    }],
    rawOutput: { exitCode: 1 },
  },

  { type: 'message', text: 'The greeting is missing a comma and the exclamation mark. Fixing it now.\n\n', charsPerTick: 12, tickMs: 40 },

  { type: 'tool_call', id: 'edit-1', title: 'Edit src/greet.ts', kind: 'edit', locations: [{ path: `${ROOT}/src/greet.ts`, line: 2 }], delayMs: 200 },
  { type: 'tool_update', id: 'edit-1', status: 'in_progress', delayMs: 150 },
  {
    type: 'tool_update', id: 'edit-1', status: 'completed', delayMs: 300,
    content: [{
      type: 'diff',
      path: `${ROOT}/src/greet.ts`,
      oldText: "export const greet = (name: string) => {\n  return 'Hello ' + name;\n};\n",
      newText: 'export const greet = (name: string) => {\n  return `Hello, ${name}!`;\n};\n',
    }],
  },

  { type: 'tool_call', id: 'exec-2', title: 'Run `pnpm test`', kind: 'execute', rawInput: { command: 'pnpm test' }, status: 'in_progress', delayMs: 200 },
  { type: 'tool_update', id: 'exec-2', status: 'completed', delayMs: 700, content: [{ type: 'text', text: 'ℹ tests 3\nℹ pass 3\nℹ fail 0' }] },

  {
    type: 'message', charsPerTick: 12, tickMs: 40,
    text: '**Fixed.** `greet` now returns `Hello, <name>!`:\n\n- read `src/greet.ts`\n- found 2 callers\n- updated the template string\n- all 3 tests pass\n',
  },
];

export default scenarioOf('tool-heavy', script);
