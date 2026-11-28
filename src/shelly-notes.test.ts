import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { endsAtLineStart, joinNotes } from './shelly.js';

describe('endsAtLineStart', () => {
  it('is decided by the last cursor-moving character', () => {
    assert.equal(endsAtLineStart('done\r\n', false), true);
    assert.equal(endsAtLineStart('progress 50%\r', false), true);
    assert.equal(endsAtLineStart('$ ', true), false);
    assert.equal(endsAtLineStart('line\nmore', true), false);
  });

  it('ignores escape sequences, keeping what came before', () => {
    assert.equal(endsAtLineStart('\u001b[?2004h\u001b]0;title\u0007', true), true);
    assert.equal(endsAtLineStart('\u001b[?2004h', false), false);
    assert.equal(endsAtLineStart('out\r\n\u001b[0m\u001b[K', false), true);
  });

  it('does not count a sequence cut off at the end of the chunk as text', () => {
    assert.equal(endsAtLineStart('out\r\n\u001b[', false), true);
    assert.equal(endsAtLineStart('out\r\n\u001b]0;half a tit', false), true);
    assert.equal(endsAtLineStart('out\r\n\u001b', false), true);
  });

  it('decides a huge chunk from its tail', () => {
    assert.equal(endsAtLineStart(`${'x'.repeat(2_000_000)}\r\n`, false), true);
    assert.equal(endsAtLineStart(`\n${'y'.repeat(10_000)}`, true), false);
  });
});

describe('joinNotes', () => {
  it('keeps every note once, in order', () => {
    assert.equal(joinNotes('A finished', undefined, 'B finished'), 'A finished · B finished');
    assert.equal(joinNotes('A finished', 'A finished'), 'A finished');
    assert.equal(joinNotes(undefined, undefined), undefined);
  });
});
