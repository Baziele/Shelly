import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { lastPromptRow } from '../tools/scenario.js';
import { startStack } from './stack.js';

/*
 * The client never loads Effect (it stays in the daemon), however much of
 * Shelly a terminal uses: a turn, a fast request, a picker. Every module a
 * real client resolves is logged (fixtures/module-log.mjs);
 * src/client/client-imports.test.ts checks the import graph itself.
 */

const ENTRY = fileURLToPath(new URL('../../src/index.ts', import.meta.url));
const MODULE_LOG_HOOK = fileURLToPath(new URL('./fixtures/module-log.mjs', import.meta.url));

const atPrompt = (lines: string[]): boolean => lines[lastPromptRow(lines)]?.trimEnd() === '$';
const isEffect = (url: string): boolean => /\/node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?(?:effect|@effect\/[^/]+)\//.test(url);

describe('the client', { timeout: 120_000 }, () => {
  it('loads no Effect module, before or after a turn and a fast request', async () => {
    const log = join(tmpdir(), `shelly-modules-${process.pid}.log`);
    const stack = await startStack({
      shell: '/bin/zsh',
      cols: 100,
      rows: 30,
      command: [process.execPath, '--experimental-ffi', '--no-warnings', '--import', MODULE_LOG_HOOK, '--import', import.meta.resolve('tsx'), ENTRY],
      env: { SHELLY_MODULE_LOG: log },
    });
    try {
      const driver = stack.driver;
      await driver.type('::');
      await driver.waitForText(':: Ask Shelly', { timeoutMs: 15_000 });
      await driver.type('run the tools\r');
      await driver.waitFor((lines) => {
        const echo = lines.findLastIndex((line) => line.startsWith('$ :: run the tools'));
        const end = lines.findLastIndex((line) => /[✓◼✗] /.test(line));
        return echo >= 0 && end > echo && atPrompt(lines) && lastPromptRow(lines) > end;
      }, 'the turn to end', { timeoutMs: 30_000, scrollback: true });

      await driver.type('__');
      await driver.waitForText('__ Describe a command', { timeoutMs: 10_000 });
      await driver.type('reply: # Use `ls -la` to see hidden files.\r');
      await driver.waitFor((lines) => lines.some((line) => line.includes('hidden files') && !line.includes('reply:')) && atPrompt(lines), 'the fast answer', { timeoutMs: 30_000 });

      const urls = readFileSync(log, 'utf8').split('\n').filter(Boolean);
      assert.ok(urls.some((url) => url.includes('/@opentui/')), 'the UI was loaded (and the log works)');
      assert.ok(urls.some((url) => url.endsWith('/src/client/rpc-connection.ts')), 'the daemon connection was loaded');
      assert.deepEqual(urls.filter(isEffect), []);
    } finally {
      await stack.stop();
      if (existsSync(log)) {
        rmSync(log);
      }
    }
  });
});
