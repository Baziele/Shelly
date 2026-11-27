import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { lastPromptRow, startShelly, type ShellyHarness } from './harness.js';

const ESCAPE = '\u001b';
const DOWN = '\u001b[B';

describe('Shelly in a real terminal', { timeout: 30_000 }, () => {
  let shelly: ShellyHarness | undefined;

  afterEach(async () => {
    await shelly?.close();
    shelly = undefined;
  });

  it('passes ordinary shell input straight through', async () => {
    shelly = await startShelly();
    await shelly.type('echo hello a::b\r');
    await shelly.waitFor((screen) => screen.includes('hello a::b'), 'command output');
  });

  it('opens its input right after the prompt, keeping the prompt on screen', async () => {
    shelly = await startShelly();
    await shelly.type('::');
    const screen = await shelly.waitFor((rows) => rows.some((row) => row.startsWith('$ :: Ask Shelly')), 'the input');
    const cursor = await shelly.cursor();
    assert.deepEqual(cursor, { row: lastPromptRow(screen) + 1, col: 6 });

    await shelly.type('hello');
    await shelly.waitFor((rows) => rows.includes('$ :: hello'), 'typed text');
  });

  it('hands the line back untouched on Escape', async () => {
    shelly = await startShelly();
    await shelly.type('::hello');
    await shelly.waitFor((rows) => rows.includes('$ :: hello'), 'typed text');
    await shelly.type(ESCAPE);
    await shelly.waitFor((rows) => rows[lastPromptRow(rows)]?.trimEnd() === '$', 'an empty prompt');

    await shelly.type('echo back\r');
    await shelly.waitFor((rows) => rows.includes('back'), 'the shell to run commands again');
  });

  it('shows matching slash commands and completes the selection', async () => {
    shelly = await startShelly();
    await shelly.type('::/');
    await shelly.waitFor((rows) => rows.some((row) => row.includes('› /ask')), 'the command popup');

    await shelly.type('s');
    const filtered = await shelly.waitFor((rows) => rows.some((row) => row.includes('› /skills')), 'filtered commands');
    assert.ok(!filtered.some((row) => row.includes('/run')), '/run does not match "s"');

    await shelly.type(DOWN + DOWN + '\t');
    await shelly.waitFor((rows) => rows.includes('$ :: /skills') && !rows.some((row) => row.includes('›')), 'completion');
  });

  it('records a submitted prompt and returns to a fresh shell prompt', async () => {
    shelly = await startShelly();
    await shelly.type('::what is up\r');
    const screen = await shelly.waitFor(
      (rows) => rows.includes('$ :: what is up') && rows[lastPromptRow(rows)]?.trimEnd() === '$',
      'the transcript and a new prompt',
    );
    const transcript = screen.indexOf('$ :: what is up');
    assert.match(screen[transcript + 1] ?? '', /isn't connected to an agent/);
    assert.equal(lastPromptRow(screen), transcript + 2);
  });

  it('exits with the shell', async () => {
    shelly = await startShelly();
    await shelly.type('exit 3\r');
    assert.equal(await shelly.close(), 3);
  });
});
