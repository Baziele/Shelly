import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import { daemonExecArgv, portableExecArgv } from './daemon-spawn.js';

describe('portableExecArgv', () => {
  it('makes loader modules absolute and leaves other flags alone', () => {
    const args = portableExecArgv(['--experimental-ffi', '--import', 'tsx', '--import=./local.mjs', '--no-warnings'], '/work/app');
    assert.equal(args[0], '--experimental-ffi');
    assert.equal(args[1], '--import');
    assert.match(args[2] ?? '', /^file:\/\/.*\/tsx\//);
    assert.equal(args[3], `--import=${pathToFileURL('/work/app/local.mjs').href}`);
    assert.equal(args[4], '--no-warnings');
  });

  it('always gives the daemon --experimental-ffi, for its lock', () => {
    assert.deepEqual(daemonExecArgv(['--no-warnings']), ['--experimental-ffi', '--no-warnings']);
    assert.deepEqual(daemonExecArgv([]), ['--disable-warning=ExperimentalWarning', '--experimental-ffi']);
    assert.deepEqual(daemonExecArgv(['--experimental-ffi', '--no-warnings']), ['--experimental-ffi', '--no-warnings']);
  });

  it("keeps the client's young-generation limit from the daemon", () => {
    assert.deepEqual(daemonExecArgv(['--experimental-ffi', '--no-warnings', '--max-semi-space-size=4']), ['--experimental-ffi', '--no-warnings']);
    assert.deepEqual(daemonExecArgv(['--max-semi-space-size', '4', '--no-warnings']), ['--experimental-ffi', '--no-warnings']);
    assert.deepEqual(daemonExecArgv(['--max_semi_space_size=4', '--no-warnings']), ['--experimental-ffi', '--no-warnings']);
  });
});
