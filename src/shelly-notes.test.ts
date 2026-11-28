import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { cutOffEscape, endsAtLineStart, joinNotes, MAX_NOTES } from './shelly.js';

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

describe('cutOffEscape', () => {
  it('returns a sequence cut off at the end, to be read with the next chunk', () => {
    assert.equal(cutOffEscape('done\r\n\u001b['), '\u001b[');
    assert.equal(cutOffEscape('x\u001b[?20'), '\u001b[?20');
    assert.equal(cutOffEscape('x\u001b]0;half a ti'), '\u001b]0;half a ti');
    assert.equal(cutOffEscape('x\u001b'), '\u001b');
  });

  it('returns nothing for complete sequences or plain text', () => {
    assert.equal(cutOffEscape('x\u001b[?2004h'), '');
    assert.equal(cutOffEscape('x\u001b]0;title\u0007'), '');
    assert.equal(cutOffEscape('plain'), '');
  });

  it('lets the second half of a split sequence be read as part of it', () => {
    // Chunk 1 ends a line, then starts a sequence; chunk 2 finishes it.
    const first = 'out\r\n\u001b[?20';
    let ended = endsAtLineStart(first, false);
    const carry = cutOffEscape(first);
    ended = endsAtLineStart(carry + '04h', ended);
    assert.equal(ended, true, 'the rest of the sequence is not text');
    // Without the carry, "04h" reads as text.
    assert.equal(endsAtLineStart('04h', true), false);
  });
});

describe('joinNotes', () => {
  it('keeps every note once, newest last', () => {
    assert.deepEqual(joinNotes(['A finished'], [], ['B finished']), ['A finished', 'B finished']);
    assert.deepEqual(joinNotes(['A finished'], ['A finished']), ['A finished']);
    assert.deepEqual(joinNotes([], []), []);
  });

  it('dedupes per note, never per joined text', () => {
    // A shown; C pending; B comes back from a failed draw: still each once.
    const pending = joinNotes(['A'], ['C'], ['B']);
    assert.deepEqual(joinNotes(pending, ['A'], ['B']), ['C', 'A', 'B']);
  });

  it('keeps only the newest few', () => {
    const many = joinNotes(['1'], ['2'], ['3'], ['4'], ['5']);
    assert.equal(many.length, MAX_NOTES);
    assert.deepEqual(many, ['3', '4', '5']);
  });
});

describe('notes below the prompt', () => {
  it('joins a later note to the one shown, once, and starts afresh after a key', async () => {
    const { startRig } = await import('../test/support/shelly-rig.js');
    const rig = await startRig();
    try {
      const notice = (text: string): void => (rig.shelly as { notice(text: string): void }).notice(text);
      const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
      notice('A finished');
      await settle();
      notice('B finished');
      await settle();
      const drawn = rig.written();
      assert.ok(drawn.includes('A finished · B finished'), 'the second note joins the first');
      assert.ok(!drawn.includes('A finished · B finished · A finished'), 'each note once');
      // A key erases the notes. With a line being typed, the next note waits
      // for the next prompt, and is printed there on its own.
      rig.type('x');
      notice('C finished');
      await settle();
      assert.ok(!rig.written().slice(drawn.length).includes('C finished'), 'not drawn under a line being typed');
      rig.type('\r');
      rig.prompt();
      await settle();
      const after = rig.written().slice(drawn.length);
      assert.ok(after.includes('C finished') && !after.includes('B finished'), JSON.stringify(after));
    } finally {
      await rig.stop();
    }
  });
});
