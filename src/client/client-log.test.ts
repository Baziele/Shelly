import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { clientLogPath, logClientError } from './client-log.js';

const home = mkdtempSync(join(tmpdir(), 'shelly-client-log-'));
after(() => rmSync(home, { recursive: true, force: true }));
const env = { SHELLY_HOME: home };

describe('logClientError', () => {
  it('appends the error and where it came from, under SHELLY_HOME', () => {
    logClientError('unhandled rejection', new Error('the daemon went away'), env);
    const text = readFileSync(clientLogPath(env), 'utf8');
    assert.match(text, /unhandled rejection: Error: the daemon went away/);
    assert.match(text, /client-log\.test\.ts/, 'with its stack');
  });

  it('moves a large log aside, and never throws', () => {
    writeFileSync(clientLogPath(env), 'x'.repeat(1_100_000));
    logClientError('uncaught exception', 'plain', env);
    assert.ok(statSync(`${clientLogPath(env)}.1`).size > 1_000_000);
    assert.match(readFileSync(clientLogPath(env), 'utf8'), /uncaught exception: plain/);
    assert.doesNotThrow(() => logClientError('x', new Error('y'), { SHELLY_HOME: '/dev/null/nowhere' }));
  });
});
