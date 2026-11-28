import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TerminalReplies } from './terminal-replies.js';

describe('TerminalReplies', () => {
  it('takes out an answer only while its query waits, one answer per query', () => {
    const replies = new TerminalReplies();
    replies.asked('\u001b[6n');
    assert.deepEqual(replies.split('x\u001b[3;1Ry'), { replies: '\u001b[3;1R', keys: 'xy' });
    assert.deepEqual(replies.split('\u001b[1;5R'), { replies: '', keys: '\u001b[1;5R' }, 'then Ctrl+F3 is a key again');
  });

  it('leaves keys that look like answers alone when nothing was asked: Ctrl+F3, and CSI n and t', () => {
    const replies = new TerminalReplies();
    for (const key of ['\u001b[1;5R', '\u001b[0n', '\u001b[8;24;80t', '\u001b]11;rgb:0000/0000/0000\u001b\\']) {
      assert.deepEqual(replies.split(key), { replies: '', keys: key });
    }
  });

  it('knows the queries shells send, and the shape of each answer', () => {
    const replies = new TerminalReplies();
    replies.asked('\u001b[?6n\u001b[5n\u001b[c\u001b[>c\u001b[?2004$p\u001b[?u\u001b[>q\u001b[18t\u001b]11;?\u001b\\\u001bP+q544e\u001b\\');
    const answers = [
      '\u001b[?3;1;1R', '\u001b[0n', '\u001b[?62;22c', '\u001b[>1;10;0c', '\u001b[?2004;2$y', '\u001b[?1u',
      '\u001bP>|xterm(390)\u001b\\', '\u001b[8;24;80t', '\u001b]11;rgb:0000/0000/0000\u001b\\', '\u001bP1+r544e=787465726d\u001b\\',
    ].join('');
    assert.deepEqual(replies.split(`a${answers}\u001b[A\u001b[15~b`), { replies: answers, keys: 'a\u001b[A\u001b[15~b' });
    assert.equal(replies.waiting, false);
  });

  it('ignores what is not a query: colours, cursor moves, a title, a hyperlink', () => {
    const replies = new TerminalReplies();
    replies.asked('\u001b[01;34mdir\u001b[0m\u001b[2A\u001b]0;title\u0007\u001b]8;;file:///x\u0007link\u001b]8;;\u0007\u001b[?2004h');
    assert.equal(replies.waiting, false);
  });

  it('follows a query split across two pieces of output', () => {
    const replies = new TerminalReplies();
    replies.asked('$ \u001b[');
    replies.asked('6n');
    assert.equal(replies.split('\u001b[2;3R').replies, '\u001b[2;3R');
  });

  it('keeps at most 32 queries waiting, however many the output holds with nobody typing', () => {
    let now = 0;
    const replies = new TerminalReplies(() => now);
    replies.asked('\u001b[6n'.repeat(1000));
    const answers = '\u001b[1;1R'.repeat(40);
    assert.equal(replies.split(answers).replies, '\u001b[1;1R'.repeat(32));
    // Expired as more come, without a key typed.
    replies.asked('\u001b[6n');
    now = 2500;
    replies.asked('\u001b[c');
    assert.equal(replies.split('\u001b[2;2R').keys, '\u001b[2;2R', 'the cursor query from before is gone');
    assert.equal(replies.split('\u001b[?62c').replies, '\u001b[?62c');
  });

  it('stops waiting for an answer a terminal never gives', () => {
    let now = 0;
    const replies = new TerminalReplies(() => now);
    replies.asked('\u001b[6n');
    now = 2500;
    assert.equal(replies.waiting, false);
    assert.equal(replies.split('\u001b[1;5R').keys, '\u001b[1;5R');
  });
});
