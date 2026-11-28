/*
 * A fake ACP agent over stdio, for tests and UI scenarios.
 *
 *   node --import tsx <abs path>/fake-acp-agent.ts --scenario <file or bundled name> [--state-dir <dir>]
 *
 * The scenario may also come from FAKE_ACP_SCENARIO (and the state dir from
 * FAKE_ACP_STATE_DIR). Without one it echoes every prompt. stdout carries
 * only protocol messages; FAKE_ACP_DEBUG=1 logs to stderr, and
 * FAKE_ACP_PROMPT_LOG appends each prompt it gets to that file.
 */
import { Readable, Writable } from 'node:stream';
import { parseArgs } from 'node:util';
import * as acp from '@agentclientprotocol/sdk';
import { createFakeAgent, loadScenario } from './fake-agent.js';

const debug = process.env.FAKE_ACP_DEBUG === '1';
const log = (message: string): void => {
  if (debug) {
    process.stderr.write(`[fake-acp-agent] ${message}\n`);
  }
};
// stdout is the protocol channel: keep stray logging off it.
console.log = console.info = console.debug = (...args: unknown[]) => log(args.map(String).join(' '));

const { values } = parseArgs({
  options: {
    scenario: { type: 'string' },
    'state-dir': { type: 'string' },
  },
});

const source = values.scenario ?? process.env.FAKE_ACP_SCENARIO;
let scenario;
try {
  scenario = source ? await loadScenario(source) : {};
} catch (error) {
  process.stderr.write(`fake-acp-agent: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(2);
}
log(`scenario: ${source ?? '(none: echo)'}`);

const app = createFakeAgent(scenario, {
  log,
  stateDir: values['state-dir'] ?? process.env.FAKE_ACP_STATE_DIR,
  ...(process.env.FAKE_ACP_PROMPT_LOG ? { promptLog: process.env.FAKE_ACP_PROMPT_LOG } : {}),
});
const connection = app.connect(acp.ndJsonStream(
  Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
  Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
));
await connection.closed;
log('connection closed');
process.exit(0);
