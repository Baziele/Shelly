import { defineScenario, type Step } from '../../../../../test/fixtures/fake-agent/types.js';

/*
 * The fake agent scenario the runtime tests drive: one rule per behaviour,
 * picked by a word in the prompt.
 */

const ask = (branches: Record<string, Step[]>): Step => ({
  type: 'permission',
  toolCall: {
    id: 'write-a',
    title: 'Write a.txt',
    kind: 'edit',
    content: [{ type: 'diff', path: '/work/a.txt', oldText: null, newText: 'hello\n' }],
    locations: [{ path: '/work/a.txt' }],
  },
  branches,
});

const bigText = Array.from({ length: 2_000 }, (_, i) => `line ${i}`).join('\n');
const oldFile = Array.from({ length: 1_000 }, (_, i) => `row ${i}`).join('\n');
const newFile = oldFile.replace('row 500', 'row 500 changed');

/** What every runtime scenario advertises: resume, close and extra directories. */
export const capabilities = {
  loadSession: true,
  sessionCapabilities: { resume: {}, close: {}, additionalDirectories: {} },
};

export default defineScenario({
  name: 'runtime',
  agentCapabilities: capabilities,
  modes: {
    currentModeId: 'default',
    availableModes: [
      { id: 'default', name: 'Default', description: 'Ask first' },
      { id: 'plan', name: 'Plan', description: null },
    ],
  },
  rules: [
    {
      match: 'permission',
      script: [ask({
        allow_once: [{ type: 'message', text: 'allowed' }],
        reject_once: [{ type: 'message', text: 'rejected' }],
      })],
    },
    {
      // OpenCode: a rejection ends the turn as cancelled.
      match: 'opencode-reject',
      script: [ask({
        allow_once: [{ type: 'message', text: 'allowed' }],
        reject_once: [{ type: 'end', stopReason: 'cancelled' }],
      })],
    },
    {
      match: 'updates',
      script: [
        { type: 'user', text: 'echo of the prompt' },
        { type: 'thought', text: 'thinking' },
        { type: 'update', update: { sessionUpdate: 'session_info_update', title: 'A generated title' } },
        { type: 'update', update: { sessionUpdate: 'available_commands_update', availableCommands: [] } },
        { type: 'update', update: { sessionUpdate: 'usage_update', used: 10, size: 1000 } },
        { type: 'plan', entries: [{ content: 'Step one', priority: 'high', status: 'in_progress' }] },
        { type: 'tool_call', id: 'read-1', title: 'Read big.txt', kind: 'read', status: 'pending', locations: [{ path: '/work/big.txt', line: 3 }] },
        { type: 'tool_update', id: 'read-1', status: 'in_progress' },
        { type: 'tool_update', id: 'read-1', status: 'completed', content: [{ type: 'text', text: bigText }] },
        {
          type: 'tool_call', id: 'edit-1', title: 'Edit big.txt', kind: 'edit', status: 'in_progress',
          content: [{ type: 'diff', path: '/work/big.txt', oldText: oldFile, newText: newFile }],
        },
        { type: 'tool_update', id: 'edit-1', status: 'failed', title: 'Edit big.txt (failed)' },
        { type: 'mode', modeId: 'plan' },
        { type: 'message', text: 'done' },
      ],
    },
    { match: 'auth', script: [{ type: 'error', code: -32000, message: 'Authentication required' }] },
    { match: 'broken', script: [{ type: 'error', code: -32603, message: 'Internal error: the model went away\nstack trace here' }] },
    {
      match: 'slow',
      script: [
        { type: 'message', text: 'starting ' },
        { type: 'wait', ms: 30_000 },
        { type: 'message', text: 'never reached' },
      ],
    },
    { match: 'refuse', script: [{ type: 'message', text: 'no' }, { type: 'end', stopReason: 'refusal' }] },
    {
      // Claude Code's command output, as Shelly asks for it (terminal_output_delta).
      match: 'run a command',
      script: [
        {
          type: 'update',
          update: {
            sessionUpdate: 'tool_call', toolCallId: 'sh-1', title: 'Terminal', kind: 'execute', status: 'pending',
            content: [{ type: 'terminal', terminalId: 'sh-1' }],
            _meta: { terminal_info: { terminal_id: 'sh-1' } },
          },
        },
        { type: 'update', update: { sessionUpdate: 'tool_call_update', toolCallId: 'sh-1', status: 'in_progress', title: 'make test' } },
        {
          type: 'update',
          update: {
            sessionUpdate: 'tool_call_update', toolCallId: 'sh-1',
            _meta: { terminal_output_delta: { terminal_id: 'sh-1', data: 'Exit code 2\nOUTPUT-MARKER line one\n\u001b[31mOUTPUT-MARKER failed\u001b[0m\n' } },
          },
        },
        {
          type: 'update',
          update: {
            sessionUpdate: 'tool_call_update', toolCallId: 'sh-1', status: 'failed',
            _meta: { terminal_exit: { terminal_id: 'sh-1', exit_code: 2, signal: null } },
          },
        },
        { type: 'message', text: 'It failed.' },
      ],
    },
  ],
});
