import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { compareVersions } from './daemon-client.js';

describe('compareVersions', () => {
  it('orders releases by their numbers', () => {
    assert.equal(compareVersions('0.1.0', '0.2.0'), -1);
    assert.equal(compareVersions('0.10.0', '0.9.9'), 1);
    assert.equal(compareVersions('1.2', '1.2.0'), 0);
    assert.equal(compareVersions('2.0.0', '2.0.0'), 0);
  });

  it('puts a pre-release before its release', () => {
    assert.equal(compareVersions('0.2.0-beta.1', '0.2.0'), -1);
    assert.equal(compareVersions('0.2.0', '0.2.0-beta.1'), 1);
    assert.equal(compareVersions('0.2.0-alpha', '0.2.0-beta'), -1);
    assert.equal(compareVersions('0.1.0', '0.2.0-beta.1'), -1);
  });

  it('calls versions it cannot read equal, so nothing acts on them', () => {
    assert.equal(compareVersions('dev', '0.1.0'), 0);
    assert.equal(compareVersions('0.1.0', ''), 0);
  });
});
