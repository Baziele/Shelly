import { defineScenario } from '../../../../../test/fixtures/fake-agent/types.js';
import { capabilities } from './runtime.js';

/** Like OpenCode: no ACP modes, only a `mode` config option whose choices are its agents. */
export default defineScenario({
  name: 'config-modes',
  agentCapabilities: capabilities,
  configOptions: [
    {
      id: 'mode',
      name: 'Mode',
      category: 'mode',
      type: 'select',
      currentValue: 'build',
      options: [
        { value: 'build', name: 'Build', description: 'Does the work' },
        { value: 'plan', name: 'Plan' },
      ],
    },
  ],
});
