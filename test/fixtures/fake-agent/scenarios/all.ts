import type { FakeAgentScenario } from '../types.js';
import { base } from './_shared.js';
import { script as errorMidTurn } from './error-mid-turn.js';
import { script as longAnswer } from './long-answer.js';
import { script as markdown } from './markdown-showcase.js';
import { script as permission } from './permission.js';
import { script as plan } from './plan.js';
import { script as slow } from './slow-first-token.js';
import { script as tools } from './tool-heavy.js';
import failingTool from './failing-tool.json' with { type: 'json' };

/**
 * Every bundled script behind one agent, chosen by a word in the prompt:
 * markdown, long, tools, permission, fail, error, slow, plan, stop. Anything
 * else is echoed.
 */
export default {
  ...base,
  name: 'all',
  rules: [
    { match: 'markdown', script: markdown },
    { match: 'long', script: longAnswer },
    { match: 'tools', script: tools },
    { match: 'permission', script: permission },
    { match: 'fail', script: (failingTool as FakeAgentScenario).defaultScript! },
    { match: 'error', script: errorMidTurn },
    { match: 'slow', script: slow },
    { match: 'plan', script: plan },
    { match: 'stop', script: [{ type: 'message', text: 'Stopping here.' }, { type: 'end', stopReason: 'max_tokens' }] },
  ],
  defaultScript: [{ type: 'echo' }],
} satisfies FakeAgentScenario;
