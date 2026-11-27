import type { FakeAgentScenario, Step } from '../types.js';

/** Modes, models and a stored history shared by the bundled scenarios. */
export const base = {
  agentInfo: { name: 'fake-acp-agent', title: 'Fake agent', version: '1.0.0' },
  modes: {
    currentModeId: 'default',
    availableModes: [
      { id: 'default', name: 'Default', description: 'Ask before edits and commands' },
      { id: 'acceptEdits', name: 'Accept edits', description: 'Edit files without asking' },
      { id: 'plan', name: 'Plan', description: 'Plan only, change nothing' },
    ],
  },
  models: {
    currentModelId: 'fake-large',
    availableModels: [
      { modelId: 'fake-large', name: 'Fake Large', description: 'Slow and thorough' },
      { modelId: 'fake-small', name: 'Fake Small', description: 'Quick answers' },
    ],
  },
  history: {
    '*': [
      { type: 'user', text: 'What does this project do?' },
      { type: 'message', text: 'It wraps your shell and lets you ask an agent for help **inline**.' },
    ],
  },
} satisfies FakeAgentScenario;

/** About 60 tokens a second: ~4 characters a token, 12 characters every 50 ms. */
export const REALISTIC = { charsPerTick: 12, tickMs: 50 } as const;

export const scenarioOf = (name: string, script: readonly Step[]): FakeAgentScenario => ({ ...base, name, defaultScript: script });
