import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { pngRoute } from '../tools/screen.js';
import { keySequence, ScenarioDriver } from '../tools/scenario.js';

describe('scenario driver keys', () => {
  it('maps named keys to what a terminal sends', () => {
    assert.equal(keySequence('enter'), '\r');
    assert.equal(keySequence('esc'), '\u001b');
    assert.equal(keySequence('backspace'), '\u007f');
    assert.equal(keySequence('ctrl-c'), '\u0003');
    assert.equal(keySequence('ctrl-d'), '\u0004');
    assert.equal(keySequence('ctrl-a'), '\u0001');
    assert.equal(keySequence('up'), '\u001b[A');
    assert.equal(keySequence('up', true), '\u001bOA', 'application cursor keys');
    assert.equal(keySequence('alt-b'), '\u001bb');
    assert.throws(() => keySequence('hello'), /Unknown key/);
  });
});

describe('scenario driver', { timeout: 60_000 }, () => {
  let driver: ScenarioDriver | undefined;
  const outDir = mkdtempSync(join(tmpdir(), 'shelly-driver-test-'));

  afterEach(async () => {
    await driver?.close();
    driver = undefined;
  });

  it('runs Shelly in a throwaway home, opens the input with :: and takes screenshots', async () => {
    driver = await ScenarioDriver.start({ shell: '/bin/zsh', cols: 80, rows: 16, outDir });
    const { home, shellyHome } = driver;
    assert.notEqual(home, homedir());
    assert.ok(existsSync(join(home, '.zshrc')));

    await driver.type('echo "$HOME"; echo "$SHELLY_HOME"\r');
    await driver.waitForText(`\n${home}\n${shellyHome}\n`);

    await driver.type('::');
    const screen = await driver.waitForText(/^\$ :: Ask Shelly/m);
    assert.ok(screen.split('\n').some((line) => line.startsWith('$ :: Ask Shelly anything')));
    assert.deepEqual(await driver.cursor(), { row: screen.split('\n').findIndex((line) => line.startsWith('$ ::')) + 1, col: 6 });

    const step = await driver.screenshot('input open');
    assert.equal(step.index, 1);
    assert.match(step.files.txt, /01-input-open\.txt$/);
    assert.match(readFileSync(step.files.txt, 'utf8'), /\$ :: Ask Shelly/);
    if (pngRoute()) {
      assert.ok(step.files.png && existsSync(step.files.png));
    }

    await driver.type('/con');
    await driver.waitForText('› /context');
    await driver.press('tab');
    await driver.waitFor((lines) => lines.some((line) => line === '$ :: /context') && !lines.some((line) => line.includes('›')), 'completion');
    await driver.press('esc');
    await driver.waitFor((lines) => lines.at(-1) !== undefined && lines.some((line) => line === '$'), 'the prompt back');
    await driver.waitForStable({ quietMs: 200 });

    await driver.resize(60, 10);
    assert.equal(driver.terminal.cols, 60);
    await driver.type('echo resized\r');
    await driver.waitForText(/^resized$/m);
    assert.equal((await driver.screenshot('resized')).index, 2);

    assert.notEqual(await driver.close(), -1, 'exits without being killed');
    assert.ok(!existsSync(home) && !existsSync(shellyHome), 'throwaway directories are removed');
  });

  it('fails a wait with the screen and a screenshot', async () => {
    driver = await ScenarioDriver.start({ shell: '/bin/bash', cols: 60, rows: 8, outDir });
    await assert.rejects(driver.waitForText('never shown', { timeoutMs: 300 }), (error: Error) =>
      /Timed out waiting for text never shown/.test(error.message) && /Screen:\n[\s\S]*\$/.test(error.message) && /Screenshot: /.test(error.message));
  });

  it('reports when Shelly exits', async () => {
    driver = await ScenarioDriver.start({ shell: '/bin/sh', cols: 60, rows: 8 });
    await driver.press('ctrl-d');
    assert.equal(await driver.waitForExit(), 0);
    assert.ok(driver.hasExited);
  });

  it('cleans up its output directory afterwards', () => {
    rmSync(outDir, { recursive: true, force: true });
  });
});
