import type { FastEvent, ThreadEvent } from './schema.js';

/*
 * Light checks of the stream values the client renders, in place of
 * decoding them against the schemas (which would load Effect into every
 * terminal). The protocol version, checked at hello, does the rest. A kind
 * of event this client does not know is skipped; a known one without the
 * fields the UI reads breaks the stream.
 */

type Verdict = 'yield' | 'skip' | 'reject';

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isString = (value: unknown): value is string => typeof value === 'string';
const isNullOrString = (value: unknown): boolean => value === null || isString(value);
const verdict = (ok: boolean): Verdict => (ok ? 'yield' : 'reject');

const isToolCall = (tool: unknown): boolean =>
  isRecord(tool) && isString(tool.id) && isString(tool.title) && isString(tool.kind) && isString(tool.status)
  && Array.isArray(tool.locations) && Array.isArray(tool.content) && tool.content.every((part) => isRecord(part) && isString(part.type));

export const checkThreadEvent = (event: unknown): Verdict => {
  if (!isRecord(event) || typeof event.seq !== 'number' || !isString(event.type)) {
    return 'reject';
  }
  const e = event as Readonly<Record<string, unknown>> & Partial<Record<keyof ThreadEvent, unknown>>;
  switch (e.type) {
    case 'turn.started':
      return verdict(isString(e.turnId) && isString(e.text));
    case 'message.chunk':
      return verdict(isString(e.turnId) && isString(e.messageId) && isString(e.text) && (e.kind === 'text' || e.kind === 'thought'));
    case 'tool.updated':
      return verdict(isString(e.turnId) && isToolCall(e.tool));
    case 'plan.updated':
      return verdict(isString(e.turnId) && Array.isArray(e.entries));
    case 'permission.requested':
      return verdict(isString(e.turnId) && isString(e.requestId) && isString(e.title) && Array.isArray(e.options));
    case 'permission.resolved':
      return verdict(isString(e.turnId) && isString(e.requestId) && isNullOrString(e.optionId));
    case 'mode.changed':
      return verdict(isString(e.currentModeId) && Array.isArray(e.availableModes));
    case 'notice':
      return verdict(isNullOrString(e.turnId) && isString(e.level) && isString(e.text));
    case 'turn.ended':
      return verdict(isString(e.turnId) && isString(e.stopReason) && isNullOrString(e.error));
    default:
      return 'skip';
  }
};

export const checkFastEvent = (event: unknown): Verdict => {
  if (!isRecord(event) || !isString(event.type)) {
    return 'reject';
  }
  switch (event.type as FastEvent['type']) {
    case 'delta':
      return verdict(isString(event.text));
    case 'done':
      return verdict(isString(event.text) && (event.kind === 'command' || event.kind === 'answer'));
    default:
      return 'skip';
  }
};

export const checkThreadEvents = (events: unknown): events is readonly ThreadEvent[] =>
  Array.isArray(events) && events.every((event) => checkThreadEvent(event) !== 'reject');
