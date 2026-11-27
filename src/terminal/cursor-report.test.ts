import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { dropCursorReports, extractCursorReport } from './cursor-report.js';

describe('extractCursorReport', () => {
  it('parses a report and keeps surrounding keystrokes', () => {
    const report = extractCursorReport('a\u001b[12;34Rb');
    assert.deepEqual(report?.position, { row: 12, col: 34 });
    assert.equal(report?.remaining, 'ab');
    assert.equal(report?.kind, 'plain');
    assert.equal(report?.ambiguous, false);
  });

  it('reads the DEC form, with or without a page', () => {
    assert.deepEqual(extractCursorReport('\u001b[?3;7R')?.position, { row: 3, col: 7 });
    assert.equal(extractCursorReport('\u001b[?3;7;1R')?.kind, 'dec');
  });

  it('marks a plain report that F3 with a modifier also sends as ambiguous', () => {
    assert.equal(extractCursorReport('\u001b[1;2R')?.ambiguous, true);
    assert.equal(extractCursorReport('\u001b[?1;2R')?.ambiguous, false);
    assert.equal(extractCursorReport('\u001b[1;9R')?.ambiguous, false);
  });

  it('returns undefined until the report is complete', () => {
    assert.equal(extractCursorReport('\u001b[12;3'), undefined);
  });

  it('drops a given number of reports', () => {
    assert.deepEqual(dropCursorReports('a\u001b[1;1Rb\u001b[?2;2Rc\u001b[3;3R', 2), { text: 'abc\u001b[3;3R', dropped: 2 });
  });
});
