import { base } from '../../fixtures/fake-agent/scenarios/_shared.js';
import { script as markdown } from '../../fixtures/fake-agent/scenarios/markdown-showcase.js';
import { script as permission } from '../../fixtures/fake-agent/scenarios/permission.js';
import { script as tools } from '../../fixtures/fake-agent/scenarios/tool-heavy.js';
import { defineScenario, type Step } from '../../fixtures/fake-agent/types.js';

/*
 * The fake agent behind the end-to-end tests, picked by a word in the
 * prompt. Anything else is echoed back, context and all, so a test can read
 * what Shelly sent.
 */

/** 120 numbered lines, quickly: taller than any test terminal. */
const longLines = Array.from({ length: 120 }, (_, i) => `- line ${String(i + 1).padStart(3, '0')} of the long answer`).join('\n');

const slowWork: Step[] = [
  { type: 'message', text: 'Starting on it.\n\n' },
  { type: 'tool_call', id: 'build', title: 'make build', kind: 'execute', status: 'in_progress' },
  { type: 'wait', ms: 2500 },
  { type: 'tool_update', id: 'build', status: 'completed', content: [{ type: 'text', text: 'build ok' }] },
  { type: 'message', text: 'The build **passed**.' },
];

export default defineScenario({
  ...base,
  name: 'e2e',
  rules: [
    { match: 'markdown', script: markdown },
    { match: 'tools', script: tools },
    { match: 'permission', script: permission },
    { match: 'long', script: [{ type: 'message', text: `Here it is:\n\n${longLines}\n\nThat was all of it.`, charsPerTick: 400, tickMs: 20 }] },
    { match: 'slow', script: slowWork },
    // Ends the turn having said nothing, as an agent that cannot work may.
    { match: 'say nothing', script: [{ type: 'end', stopReason: 'end_turn' }] },
    {
      match: 'name yourself',
      script: [
        { type: 'update', update: { sessionUpdate: 'session_info_update', title: 'Agent picked title' } },
        { type: 'message', text: 'Named.' },
      ],
    },
  ],
  defaultScript: [{ type: 'echo' }],
});
