import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { splitAfterRows } from './line-split.js';

describe('splitAfterRows', () => {
  it('finds where the next row starts in plain prose, the wrap taking the space', () => {
    const source = 'The shell hands its line to Shelly when you type two colons.';
    const rows = ['The shell hands its line', 'to Shelly when you type'];
    assert.deepEqual(splitAfterRows(source, rows), { rows: 2, offset: source.indexOf('two') });
  });

  it('follows markup the renderer hides, and soft line breaks shown as spaces', () => {
    const source = 'Run **pnpm test** and\nthen `git status` to see what changed.';
    const rows = ['Run pnpm test and then', 'git status to see what'];
    assert.deepEqual(splitAfterRows(source, rows), { rows: 2, offset: source.indexOf('changed') });
  });

  it('keeps backticks that are shown (without colour)', () => {
    const source = 'Then `git status` shows it all.';
    assert.deepEqual(splitAfterRows(source, ['Then `git status`'], { codeMarks: true }), { rows: 1, offset: source.indexOf('shows') });
  });

  it('cuts only where the markup before is balanced: never inside bold text', () => {
    const source = 'Some **bold words that wrap** and more after them.';
    // Row 1 ends inside the bold span: no cut there. Row 2 ends after it: cut.
    assert.deepEqual(splitAfterRows(source, ['Some bold words', 'that wrap and']), { rows: 2, offset: source.indexOf('more') });
    assert.equal(splitAfterRows(source, ['Some bold words']), undefined);
  });

  it('does not cut after an unclosed marker still shown as text', () => {
    const source = 'Streaming **bold that is not closed yet and goes on';
    assert.equal(splitAfterRows(source, ['Streaming **bold that is']), undefined);
  });

  it('gives up on what it cannot follow, such as a link', () => {
    const source = 'See [the docs](https://example.com/docs) for the rest of it.';
    assert.equal(splitAfterRows(source, ['See the docs for the']), undefined);
  });

  it('follows a long word broken across rows, with no space taken', () => {
    const source = `${'a'.repeat(30)} tail`;
    assert.deepEqual(splitAfterRows(source, ['a'.repeat(20)]), { rows: 1, offset: 20 });
  });

  it('never cuts at the very end of what has arrived: the last row is still being written', () => {
    const source = 'Only one row so far';
    assert.equal(splitAfterRows(source, ['Only one row so far']), undefined);
  });
});
