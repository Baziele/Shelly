import type { Step } from '../types.js';
import { REALISTIC, scenarioOf } from './_shared.js';

/** Nothing for three seconds, then a normal answer: for spinners and "thinking…" states. */
export const script: Step[] = [
  { type: 'message', delayMs: 3000, text: 'Sorry for the wait. Here is the answer: **42**.', ...REALISTIC },
];

export default scenarioOf('slow-first-token', script);
