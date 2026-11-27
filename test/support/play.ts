import { setTimeout as sleep } from 'node:timers/promises';
import type { AgentView } from '../../src/ui/agent/agent-view.js';
import { timeline, type Fixture } from '../fixtures/thread-events/load.js';

/** Longest a fixture's keystrokes wait for the prompt they answer to be on screen and armed. */
const PROMPT_WAIT_MS = 10_000;

/**
 * Play a fixture's events and keystrokes into an agent view with its timing,
 * `speed` times faster. Keystrokes meant for a permission prompt wait until
 * the prompt is on screen and armed, however long drawing it takes, so a
 * loaded machine cannot make them land early.
 */
export const playFixture = async (view: AgentView, fixture: Fixture, speed = 1): Promise<void> => {
  const start = performance.now();
  let delay = 0;
  for (const action of timeline(fixture, { speed })) {
    const wait = action.at + delay - (performance.now() - start);
    if (wait > 1) {
      await sleep(wait);
    }
    if (action.type === 'event') {
      view.apply(action.event);
    } else if (action.type === 'keys') {
      const waitedFrom = performance.now();
      const deadline = waitedFrom + PROMPT_WAIT_MS;
      while (view.promptState === 'arming' && performance.now() < deadline) {
        await sleep(10);
      }
      delay += performance.now() - waitedFrom;
      view.handleInput(action.keys);
    }
  }
};
