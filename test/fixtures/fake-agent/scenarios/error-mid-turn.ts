import type { Step } from '../types.js';
import { scenarioOf } from './_shared.js';

/** Streams part of an answer, starts a tool, then fails the prompt request with a JSON-RPC error. */
export const script: Step[] = [
  { type: 'message', text: 'Starting on that. First I will look at the logs, then', charsPerTick: 8, tickMs: 40 },
  { type: 'tool_call', id: 'logs', title: 'Read /var/log/app.log', kind: 'read', status: 'in_progress', delayMs: 200 },
  { type: 'error', code: -32603, message: 'Internal error: the model provider is overloaded', data: { retryAfterMs: 5000 }, delayMs: 400 },
];

export default scenarioOf('error-mid-turn', script);
