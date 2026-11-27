import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { displayWidth, truncateEnd, truncateStart } from './text-width.js';

describe('displayWidth', () => {
  it('counts wide characters, emoji and combining marks like a terminal', () => {
    assert.equal(displayWidth('abc'), 3);
    assert.equal(displayWidth('漢字'), 4);
    assert.equal(displayWidth('🚀'), 2);
    assert.equal(displayWidth('👩‍💻'), 2);
    assert.equal(displayWidth('é'), 1);
    assert.equal(displayWidth('●○✗☐◐☑'), 6);
  });
});

describe('truncation', () => {
  it('cuts to a width with an ellipsis, never splitting a wide character', () => {
    assert.equal(truncateEnd('hello world', 8), 'hello w…');
    assert.equal(truncateEnd('short', 8), 'short');
    assert.equal(truncateEnd('漢字漢字', 6), '漢字…');
    assert.equal(truncateStart('/a/very/long/path', 8), '…ng/path');
    assert.equal(truncateStart('漢字漢字', 5), '…漢字');
  });
});
