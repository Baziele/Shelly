import type { Step } from '../types.js';
import { scenarioOf } from './_shared.js';

const PATH = '/workspace/demo/.env.example';

/** Asks before an edit; what happens next depends on the option the client picks. */
export const script: Step[] = [
  { type: 'message', text: 'I need to add a setting to `.env.example`.\n\n', charsPerTick: 12, tickMs: 30 },
  {
    type: 'tool_call', id: 'edit-env', title: 'Edit .env.example', kind: 'edit', locations: [{ path: PATH }],
    content: [{ type: 'diff', path: PATH, oldText: 'PORT=3000\n', newText: 'PORT=3000\nLOG_LEVEL=info\n' }],
  },
  {
    type: 'permission',
    toolCall: { id: 'edit-env', title: 'Edit .env.example', kind: 'edit' },
    branches: {
      allow_once: [
        { type: 'tool_update', id: 'edit-env', status: 'in_progress', delayMs: 100 },
        { type: 'tool_update', id: 'edit-env', status: 'completed', delayMs: 200 },
        { type: 'message', text: 'Added `LOG_LEVEL=info` (allowed once).' },
      ],
      allow_always: [
        { type: 'mode', modeId: 'acceptEdits' },
        { type: 'tool_update', id: 'edit-env', status: 'completed', delayMs: 200 },
        { type: 'message', text: "Added `LOG_LEVEL=info`. I won't ask again for edits this session." },
      ],
      reject_once: [
        { type: 'tool_update', id: 'edit-env', status: 'failed', content: [{ type: 'text', text: 'Rejected by the user' }] },
        { type: 'message', text: 'Understood, I left `.env.example` alone.' },
      ],
      reject_always: [
        { type: 'tool_update', id: 'edit-env', status: 'failed' },
        { type: 'message', text: "Understood, I won't edit files." },
      ],
    },
  },
];

export default scenarioOf('permission', script);
