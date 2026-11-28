import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { clientLogPath, logClientError, rotateClientLog } from './client-log.js';

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

  /** A SHELLY_HOME of its own, and its log directory's contents after `run`. */
  const inOwnHome = (run: (env: { SHELLY_HOME: string }, path: string) => void): string[] => {
    const own = { SHELLY_HOME: mkdtempSync(join(tmpdir(), 'shelly-client-log-')) };
    try {
      mkdirSync(dirname(clientLogPath(own)), { recursive: true });
      run(own, clientLogPath(own));
      return readdirSync(dirname(clientLogPath(own))).sort();
    } finally {
      rmSync(own.SHELLY_HOME, { recursive: true, force: true });
    }
  };

  it('keeps of an error its name, its message\'s first line cut short, and its stack frames: never the value it echoed', () => {
    inOwnHome((own, path) => {
      const error = new TypeError(`decode failed: ${'x'.repeat(300)}\nexpected string, got "my secret prompt"`);
      logClientError('unhandled rejection', error, own);
      logClientError('unhandled rejection', 'a reason\nwith what the command printed', own);
      const text = readFileSync(path, 'utf8');
      assert.match(text, /unhandled rejection: TypeError: decode failed: x{150}/);
      assert.doesNotMatch(text, /x{201}/, 'cut to about 200 characters');
      assert.doesNotMatch(text, /secret|what the command printed/);
      assert.match(text, /\n\s+at .*client-log\.test\.ts/, 'the frames');
      assert.match(text, /rejection: a reason\n/);
    });
  });

  it('leaves nothing behind when the rotated log cannot be put in place', () => {
    const left = inOwnHome((own, path) => {
      // A directory where client.log.1 goes: the move into place fails.
      mkdirSync(`${path}.1`);
      writeFileSync(join(`${path}.1`, 'keep'), '');
      writeFileSync(path, 'x'.repeat(1_100_000));
      logClientError('unhandled rejection', 'after', own);
      assert.match(readFileSync(path, 'utf8'), /after/, 'still logged');
    });
    assert.deepEqual(left, ['client.log', 'client.log.1']);
  });

  it('puts back a newer log another Shelly started between the size check and the move', () => {
    const left = inOwnHome((_, path) => {
      writeFileSync(path, 'x'.repeat(1_100_000));
      rotateClientLog(path, () => {
        // Another Shelly rotates the full log and writes to a new one.
        renameSync(path, `${path}.1`);
        writeFileSync(path, 'newer\n');
      });
      assert.equal(readFileSync(path, 'utf8'), 'newer\n', 'the newer log stays');
      assert.equal(statSync(`${path}.1`).size, 1_100_000, 'the full one is the rotated one');
    });
    assert.deepEqual(left, ['client.log', 'client.log.1'], 'nothing left over');
  });
});
