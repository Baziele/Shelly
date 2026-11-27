import { setTimeout as sleep } from 'node:timers/promises';
import type { AgentView } from '../../src/ui/agent/agent-view.js';
import { timeline, type Fixture } from '../fixtures/thread-events/load.js';

/** Play a fixture's events and keystrokes into an agent view with its timing, `speed` times faster. */
export const playFixture = async (view: AgentView, fixture: Fixture, speed = 1): Promise<void> => {
  const start = performance.now();
  for (const action of timeline(fixture, { speed })) {
    const wait = action.at - (performance.now() - start);
    if (wait > 1) {
      await sleep(wait);
    }
    if (action.type === 'event') {
      view.apply(action.event);
    } else if (action.type === 'keys') {
      view.handleInput(action.keys);
    }
  }
};
