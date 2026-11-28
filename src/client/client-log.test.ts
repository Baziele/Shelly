import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
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

  it('keeps the log and the one moved aside private (0600): stacks name paths in the home', () => {
    const own = { SHELLY_HOME: mkdtempSync(join(tmpdir(), 'shelly-client-log-mode-')) };
    try {
      logClientError('unhandled rejection', new Error('x'), own);
      assert.equal(statSync(clientLogPath(own)).mode & 0o777, 0o600);
      writeFileSync(clientLogPath(own), 'x'.repeat(1_100_000));
      chmodSync(clientLogPath(own), 0o644);
      logClientError('unhandled rejection', new Error('y'), own);
      assert.equal(statSync(`${clientLogPath(own)}.1`).mode & 0o777, 0o600, 'the one moved aside');
      assert.equal(statSync(clientLogPath(own)).mode & 0o777, 0o600, 'the new one');
      assert.deepEqual(readdirSync(dirname(clientLogPath(own))).sort(), ['client.log', 'client.log.1'], 'nothing left over from the move');
    } finally {
      rmSync(own.SHELLY_HOME, { recursive: true, force: true });
    }
  });

  it('makes private a log written before logs were', () => {
    const own = { SHELLY_HOME: mkdtempSync(join(tmpdir(), 'shelly-client-log-mode-')) };
    try {
      logClientError('first', 'x', own);
      // As an older Shelly left it.
      writeFileSync(clientLogPath(own), 'old\n');
      chmodSync(clientLogPath(own), 0o644);
      logClientError('second', 'y', own);
      assert.equal(statSync(clientLogPath(own)).mode & 0o777, 0o600);
      assert.match(readFileSync(clientLogPath(own), 'utf8'), /^old\n.*second: y\n$/s);
    } finally {
      rmSync(own.SHELLY_HOME, { recursive: true, force: true });
    }
  });
});
