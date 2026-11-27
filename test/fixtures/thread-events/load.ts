import { readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastEvent, ThreadEvent } from '../../../src/protocol/schema.js';

/*
 * Synthetic ThreadEvent sequences with timing, for the UI demo and tests.
 *
 * A fixture is JSON: `{ kind, title, prompt, agent, cwd, home, steps }`.
 * Each step waits `after` ms (default 0), then does one thing:
 * - `event`: a ThreadEvent without `seq` (numbered automatically);
 * - `stream`: text sent as many `message.chunk` events, `chunk` characters every `every` ms;
 * - `keys`: keystrokes as if the user typed them (for permission prompts);
 * - `fast`: a fast-mode event (`delta` or `done`); `fastStream` streams deltas like `stream`;
 *   `fastError`: the request fails with this message.
 * `at` in turn.started is filled in with the time it is played.
 */

type EventWithoutSeq = ThreadEvent extends infer E ? (E extends ThreadEvent ? Omit<E, 'seq'> : never) : never;

export interface StreamStep {
  readonly turnId: string;
  readonly messageId: string;
  readonly kind?: 'text' | 'thought';
  readonly text: string;
  readonly chunk?: number;
  readonly every?: number;
}

export type FixtureStep =
  | { readonly after?: number; readonly event: EventWithoutSeq }
  | { readonly after?: number; readonly stream: StreamStep }
  | { readonly after?: number; readonly keys: string }
  | { readonly after?: number; readonly fast: FastEvent }
  | { readonly after?: number; readonly fastError: string }
  | { readonly after?: number; readonly fastStream: { readonly text: string; readonly chunk?: number; readonly every?: number } };

export interface Fixture {
  readonly name: string;
  /** `agent`: a live turn. `history`: a past thread rendered statically. `fast`: a fast-mode request. */
  readonly kind: 'agent' | 'history' | 'fast';
  readonly description: string;
  readonly prompt: string;
  readonly agent: string;
  readonly cwd: string;
  readonly home: string;
  /** History only: the thread's title and when it was last updated, relative to now. */
  readonly title?: string;
  readonly updatedAgoMs?: number;
  /** Fast mode only: the command line being rewritten. */
  readonly buffer?: string;
  readonly steps: readonly FixtureStep[];
}

export type TimedAction =
  | { readonly at: number; readonly type: 'event'; readonly event: ThreadEvent }
  | { readonly at: number; readonly type: 'keys'; readonly keys: string }
  | { readonly at: number; readonly type: 'fast'; readonly event: FastEvent }
  | { readonly at: number; readonly type: 'fast-error'; readonly message: string };

const DIRECTORY = dirname(fileURLToPath(import.meta.url));

export const fixtureNames = (): string[] =>
  readdirSync(DIRECTORY).filter((file) => file.endsWith('.json')).map((file) => basename(file, '.json')).sort();

export const loadFixture = (name: string): Fixture => {
  const raw = JSON.parse(readFileSync(join(DIRECTORY, `${name}.json`), 'utf8')) as Omit<Fixture, 'name'>;
  return { ...raw, name };
};

const splitText = (text: string, size: number): string[] => {
  const pieces: string[] = [];
  const characters = Array.from(text);
  for (let index = 0; index < characters.length; index += size) {
    pieces.push(characters.slice(index, index + size).join(''));
  }
  return pieces;
};

/**
 * The fixture as a timeline: when (ms from the start) each event or keystroke
 * happens. `speed` > 1 plays faster. `startedAt` fills turn.started's `at`.
 */
export const timeline = (fixture: Fixture, { speed = 1, startedAt = Date.now() } = {}): TimedAction[] => {
  const actions: TimedAction[] = [];
  let time = 0;
  let seq = 1;
  const push = (event: EventWithoutSeq): void => {
    const withSeq = { ...event, seq: seq++ } as ThreadEvent;
    if (withSeq.type === 'turn.started') {
      actions.push({ at: time, type: 'event', event: { ...withSeq, at: startedAt + time } });
    } else {
      actions.push({ at: time, type: 'event', event: withSeq });
    }
  };

  for (const step of fixture.steps) {
    time += (step.after ?? 0) / speed;
    if ('event' in step) {
      push(step.event);
    } else if ('stream' in step) {
      const { turnId, messageId, kind = 'text', text, chunk = 6, every = 16 } = step.stream;
      splitText(text, chunk).forEach((piece, index) => {
        if (index > 0) {
          time += every / speed;
        }
        push({ type: 'message.chunk', turnId, messageId, kind, text: piece });
      });
    } else if ('keys' in step) {
      actions.push({ at: time, type: 'keys', keys: step.keys });
    } else if ('fast' in step) {
      actions.push({ at: time, type: 'fast', event: step.fast });
    } else if ('fastError' in step) {
      actions.push({ at: time, type: 'fast-error', message: step.fastError });
    } else {
      const { text, chunk = 4, every = 20 } = step.fastStream;
      splitText(text, chunk).forEach((piece, index) => {
        if (index > 0) {
          time += every / speed;
        }
        actions.push({ at: time, type: 'fast', event: { type: 'delta', text: piece } });
      });
    }
  }
  return actions;
};

/** Every ThreadEvent of a fixture, in order, ignoring timing (for history rendering). */
export const fixtureEvents = (fixture: Fixture, startedAt = Date.now()): ThreadEvent[] =>
  timeline(fixture, { startedAt }).flatMap((action) => (action.type === 'event' ? [action.event] : []));
