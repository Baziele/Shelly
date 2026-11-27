import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { extractCursorReport } from './cursor-report.js';

describe('extractCursorReport', () => {
  it('parses a report and keeps surrounding keystrokes', () => {
    assert.deepEqual(extractCursorReport('a\u001b[12;34Rb'), { position: { row: 12, col: 34 }, remaining: 'ab' });
  });

  it('returns undefined until the report is complete', () => {
    assert.equal(extractCursorReport('\u001b[12;3'), undefined);
  });
});
