import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { lastPromptRow, startShelly, type ShellyHarness } from './harness.js';

const ESCAPE = '\u001b';

describe('Shelly in a real terminal', { timeout: 90_000 }, () => {
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
    await shelly.waitFor((rows) => rows.some((row) => row.includes('› /new')), 'the command popup');

    await shelly.type('thr');
    const filtered = await shelly.waitFor((rows) => rows.some((row) => row.includes('› /threads')), 'filtered commands');
    assert.ok(!filtered.some((row) => row.includes('/new')), '/new does not match "thr"');

    await shelly.type('\t');
    await shelly.waitFor((rows) => rows.some((row) => row.startsWith('$ :: /threads')) && !rows.some((row) => row.includes('›')), 'completion');
  });

  it('says what is missing when no agent is set up, and returns to a fresh shell prompt', async () => {
    shelly = await startShelly();
    await shelly.type('::what is up\r');
    const screen = await shelly.waitFor(
      (rows) => rows.includes('$ :: what is up') && lastPromptRow(rows) > rows.indexOf('$ :: what is up'),
      'the transcript and a new prompt',
      { timeoutMs: 20_000 },
    );
    const transcript = screen.indexOf('$ :: what is up');
    assert.match(screen[transcript + 1] ?? '', /✗ .*agent/i);
    assert.equal(lastPromptRow(screen), transcript + 2, 'no blank line before the prompt');
  });

  it('stays a plain shell when its background service cannot start, and says why on ::', async () => {
    // A socket path past the limit (104 bytes on macOS, 108 on Linux, where /tmp is short): the daemon refuses to start.
    const home = mkdtempSync(join(tmpdir(), 'shelly-'));
    const shellyHome = join(home, 'x'.repeat(120));
    try {
      // Wide enough for the whole log path; the short start timeout keeps the test quick.
      shelly = await startShelly({ shell: '/bin/zsh', cols: 320, env: { SHELLY_HOME: shellyHome, SHELLY_DAEMON_START_TIMEOUT_MS: '1000' } });
      await shelly.type('::');
      const screen = await shelly.waitFor(
        (rows) => rows.some((row) => row.includes("background service did not start")),
        'the reason under the input',
        { timeoutMs: 15_000 },
      );
      assert.ok(screen.some((row) => row.includes(join(shellyHome, 'logs', 'daemon.log'))), `names the log:\n${screen.join('\n')}`);
      await shelly.type(ESCAPE);
      await shelly.waitFor((rows) => rows[lastPromptRow(rows)]?.trimEnd() === '$', 'the prompt back');
      await shelly.type('echo still a shell\r');
      await shelly.waitFor((rows) => rows.includes('still a shell'), 'the shell to run commands');
    } finally {
      await shelly?.close();
      shelly = undefined;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('exits with the shell', async () => {
    shelly = await startShelly();
    await shelly.type('exit 3\r');
    assert.equal(await shelly.close(), 3);
  });
});
