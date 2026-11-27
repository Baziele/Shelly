import { echoScript, FakeAgents } from '../../src/daemon/testing/FakeAgentRuntime.js';

/*
 * Loaded by a spawned daemon through SHELLY_DAEMON_TEST_RUNTIME: fake agents
 * that answer each prompt with an echo (see echoScript). An agent asked to
 * "ignore cancel" never acknowledges a cancel (a stuck agent).
 */
export const layer = new FakeAgents({ script: echoScript, ignoresCancel: (prompt) => prompt.includes('ignore cancel') }).layer();
