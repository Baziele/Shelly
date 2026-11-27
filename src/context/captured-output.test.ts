import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CAPTURE_HEAD_CHARS, CAPTURE_TAIL_CHARS, CapturedOutput } from './captured-output.js';

describe('CapturedOutput', () => {
  it('keeps everything while it fits', () => {
    const output = new CapturedOutput();
    output.append('one\r\n');
    output.append('two\r\n');
    output.finish();
    assert.deepEqual(output.snapshot(), { head: 'one\r\ntwo\r\n', tail: '', omittedChars: 0, usedFullScreen: false });
  });

  it('keeps the start and the end of long output', () => {
    const output = new CapturedOutput();
    let written = 0;
    while (written < CAPTURE_HEAD_CHARS + CAPTURE_TAIL_CHARS * 3) {
      output.append(String(written % 10).repeat(1000));
      written += 1000;
    }
    output.append('THE END');
    output.finish();

    const snapshot = output.snapshot();
    assert.equal(snapshot.head.length, CAPTURE_HEAD_CHARS);
    assert.equal(snapshot.tail.length, CAPTURE_TAIL_CHARS);
    assert.ok(snapshot.tail.endsWith('THE END'));
    assert.equal(snapshot.head.length + snapshot.omittedChars + snapshot.tail.length, written + 'THE END'.length);
  });

  it('drops what full-screen programs draw, even when a switch is split across chunks', () => {
    const output = new CapturedOutput();
    output.append('before\r\n\u001b[?10');
    output.append('49hvim screen contents\u001b[?1049');
    output.append('lafter\r\n');
    output.finish();

    const snapshot = output.snapshot();
    assert.equal(snapshot.head, 'before\r\nafter\r\n');
    assert.equal(snapshot.usedFullScreen, true);
  });

  it('keeps a trailing escape that turned out not to be a screen switch', () => {
    const output = new CapturedOutput();
    output.append('text\u001b[?47');
    output.finish();
    assert.equal(output.snapshot().head, 'text\u001b[?47');
  });
});
