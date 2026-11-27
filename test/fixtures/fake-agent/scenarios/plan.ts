import type { PlanEntry } from '@agentclientprotocol/sdk';
import type { Step } from '../types.js';
import { scenarioOf } from './_shared.js';

const TASKS = ['Read the failing test', 'Find the cause', 'Fix the bug', 'Run the tests again'];

const plan = (done: number, active: number | undefined): Step => ({
  type: 'plan',
  entries: TASKS.map((content, i): PlanEntry => ({
    content,
    priority: i < 2 ? 'high' : 'medium',
    status: i < done ? 'completed' : i === active ? 'in_progress' : 'pending',
  })),
});

/** Sends a plan, then updates each entry as the work progresses. */
export const script: Step[] = [
  { type: 'message', text: "Here's my plan.\n\n", charsPerTick: 12, tickMs: 30 },
  plan(0, undefined),
  ...TASKS.flatMap((task, i): Step[] => [
    { ...plan(i, i), delayMs: 300 },
    { type: 'message', text: `${task}… done.\n`, delayMs: 300, charsPerTick: 10, tickMs: 30 },
  ]),
  { ...plan(TASKS.length, undefined), delayMs: 200 },
  { type: 'message', text: '\nAll four steps are complete.' },
];

export default scenarioOf('plan', script);
