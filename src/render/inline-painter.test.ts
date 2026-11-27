import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { InlinePainter, type PaintFrame, type PaintSpan } from './inline-painter.js';
import { DEFAULT_COLOR } from './sgr.js';

const plain = (text: string): PaintSpan => ({
  text,
  width: text.length,
  style: { fg: DEFAULT_COLOR, bg: DEFAULT_COLOR, attributes: 0 },
});
const frame = (rows: string[], cursor = { row: 1, col: 1, visible: true }): PaintFrame => ({
  rows: rows.map((row) => [plain(row)]),
  cursor,
});
const SYNC_START = '\u001b[?2026h\u001b[?25l';

describe('InlinePainter', () => {
  it('starts the first row at the anchor column and leaves the prompt alone', () => {
    const painter = new InlinePainter('truecolor');
    // The frame's first 10 cells are layout padding standing in for the prompt.
    const output = painter.paint(frame(['          hi   ', 'below'], { row: 1, col: 13, visible: true }), { row: 5, col: 11 });

    assert.equal(
      output,
      `${SYNC_START}`
        + '\u001b[5;11H\u001b[0mhi\u001b[0m\u001b[K'
        + '\u001b[6;1H\u001b[0mbelow\u001b[0m\u001b[K'
        + '\u001b[5;13H\u001b[?25h'
        + '\u001b[?2026l',
    );
  });

  it('repaints only rows that changed', () => {
    const painter = new InlinePainter('truecolor');
    const anchor = { row: 1, col: 1 };
    painter.paint(frame(['a', 'b']), anchor);
    const output = painter.paint(frame(['a', 'c']), anchor);

    assert.ok(!output.includes('\u001b[1;1H\u001b[0ma'), 'unchanged row was repainted');
    assert.ok(output.includes('\u001b[2;1H\u001b[0mc'));
  });

  it('erases rows the frame no longer uses', () => {
    const painter = new InlinePainter('truecolor');
    const anchor = { row: 3, col: 1 };
    painter.paint(frame(['a', 'b', 'c']), anchor);
    const output = painter.paint(frame(['a']), anchor);

    assert.ok(output.includes('\u001b[4;1H\u001b[2K'));
    assert.ok(output.includes('\u001b[5;1H\u001b[2K'));
  });

  it('erases from the anchor down when closing', () => {
    const painter = new InlinePainter('truecolor');
    assert.equal(painter.erase({ row: 7, col: 4 }), '\u001b[7;4H\u001b[0m\u001b[J\u001b[?25h');
  });
});
