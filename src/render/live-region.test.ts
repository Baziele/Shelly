import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import xterm from '@xterm/headless';
import { LiveRegion, rowsNeeded, type PaintRow } from './live-region.js';
import { displayWidth } from './text-width.js';
import { DEFAULT_COLOR } from './sgr.js';
import { useModernWidths } from '../../test/tools/unicode.js';

const row = (text: string): PaintRow => [{ text, width: displayWidth(text), style: { fg: DEFAULT_COLOR, bg: DEFAULT_COLOR, attributes: 0 } }];
const rows = (...texts: string[]): PaintRow[] => texts.map(row);

/** An emulated terminal: everything written lands in xterm.js, scrollback included. */
const emulate = (cols: number, height: number) => {
  const terminal = new xterm.Terminal({ cols, rows: height, allowProposedApi: true, scrollback: 1000 });
  // Wide characters as modern terminals (and Shelly) measure them.
  useModernWidths(terminal);
  let written = '';
  const screen = {
    get size() {
      return { cols: terminal.cols, rows: terminal.rows };
    },
    write: (data: string) => {
      written += data;
      terminal.write(data);
    },
  };
  const flush = () => new Promise<void>((resolve) => terminal.write('', resolve));
  const lines = async (): Promise<string[]> => {
    await flush();
    const buffer = terminal.buffer.active;
    return Array.from({ length: buffer.length }, (_, index) => buffer.getLine(index)?.translateToString(true) ?? '');
  };
  const visible = async (): Promise<string[]> => {
    await flush();
    const buffer = terminal.buffer.active;
    return Array.from({ length: height }, (_, index) => buffer.getLine(buffer.viewportY + index)?.translateToString(true) ?? '');
  };
  const cursor = async () => {
    await flush();
    return { row: terminal.buffer.active.cursorY + 1, col: terminal.buffer.active.cursorX + 1 };
  };
  return { terminal, screen, flush, lines, visible, cursor, written: () => written, reset: () => { written = ''; } };
};

describe('LiveRegion', () => {
  it('commits rows as lines and repaints the live region below them', async () => {
    const term = emulate(20, 6);
    term.screen.write('$ :: hi\r\n');
    const region = new LiveRegion(term.screen, 'truecolor', { marginRows: 1 });
    region.start(await term.cursor());

    region.update([], rows('working'));
    assert.deepEqual((await term.visible()).slice(0, 3), ['$ :: hi', 'working', '']);

    region.update(rows('answer one'), rows('working 2'));
    assert.deepEqual((await term.visible()).slice(0, 4), ['$ :: hi', 'answer one', 'working 2', '']);
    assert.deepEqual(await term.cursor(), { row: 3, col: 1 }, 'cursor parks on the live region');
  });

  it('scrolls committed rows into scrollback, whole and in order, at the bottom of the screen', async () => {
    const term = emulate(20, 5);
    term.screen.write('$ :: go\r\n');
    const region = new LiveRegion(term.screen, 'truecolor', { marginRows: 1 });
    region.start(await term.cursor());

    for (let index = 1; index <= 12; index++) {
      region.update(rows(`line ${index}`), rows('status a', 'status b'));
    }
    const all = await term.lines();
    const expected = ['$ :: go', ...Array.from({ length: 12 }, (_, index) => `line ${index + 1}`), 'status a', 'status b'];
    assert.deepEqual(all.filter((line) => line !== ''), expected);
    assert.deepEqual((await term.visible()).slice(-2), ['status a', 'status b']);
  });

  it('shows the tail of a live region taller than the screen allows', async () => {
    const term = emulate(20, 5);
    const region = new LiveRegion(term.screen, 'truecolor', { marginRows: 2 });
    region.start({ row: 1, col: 1 });
    region.update([], rows('a', 'b', 'c', 'd', 'e', 'f'));
    assert.deepEqual(await term.visible(), ['d', 'e', 'f', '', '']);
  });

  it('grows past the bottom by scrolling, without losing rows above', async () => {
    const term = emulate(20, 4);
    term.screen.write('one\r\ntwo\r\nthree\r\n');
    const region = new LiveRegion(term.screen, 'truecolor', { marginRows: 1 });
    region.start(await term.cursor());
    region.update([], rows('x', 'y', 'z'));
    assert.deepEqual(await term.visible(), ['three', 'x', 'y', 'z']);
    assert.deepEqual((await term.lines()).slice(0, 2), ['one', 'two']);
  });

  it('rewrites only rows that changed', async () => {
    const term = emulate(20, 6);
    const region = new LiveRegion(term.screen, 'truecolor');
    region.start({ row: 1, col: 1 });
    region.update([], rows('same', 'old'));
    term.reset();
    region.update([], rows('same', 'new'));
    assert.ok(!term.written().includes('same'), 'unchanged row was rewritten');
    assert.ok(term.written().includes('new'));
  });

  it('erases rows the live region no longer uses', async () => {
    const term = emulate(20, 6);
    const region = new LiveRegion(term.screen, 'truecolor');
    region.start({ row: 1, col: 1 });
    region.update([], rows('a', 'b', 'c'));
    region.update([], rows('a'));
    assert.deepEqual((await term.visible()).slice(0, 3), ['a', '', '']);
  });

  it('starts on the next row when the cursor is mid-line', async () => {
    const term = emulate(20, 3);
    term.screen.write('\r\n\r\n$ :: hi');
    const region = new LiveRegion(term.screen, 'truecolor');
    region.start(await term.cursor());
    region.update([], rows('out'));
    assert.deepEqual(await term.visible(), ['', '$ :: hi', 'out']);
  });

  it('leaves the cursor on a fresh line below everything when finished', async () => {
    const term = emulate(20, 6);
    const region = new LiveRegion(term.screen, 'truecolor');
    region.start({ row: 1, col: 1 });
    region.update(rows('kept'), rows('live 1', 'live 2'));
    region.finish();
    assert.deepEqual((await term.visible()).slice(0, 3), ['kept', '', '']);
    assert.deepEqual(await term.cursor(), { row: 2, col: 1 });
    assert.ok(term.written().endsWith('\u001b[?25h\u001b[?2026l'), 'cursor shown again');
  });

  it('re-anchors on the reported cursor after a resize', async () => {
    const term = emulate(20, 6);
    const region = new LiveRegion(term.screen, 'truecolor');
    region.start({ row: 1, col: 1 });
    region.update(rows('kept'), rows('live'));
    region.relayout({ row: 2, col: 1 });
    region.update([], rows('relaid'));
    assert.deepEqual((await term.visible()).slice(0, 3), ['kept', 'relaid', '']);
  });

  it('keeps a full-width row intact', async () => {
    const term = emulate(10, 4);
    const region = new LiveRegion(term.screen, 'truecolor');
    region.start({ row: 1, col: 1 });
    region.update(rows('0123456789'), rows('abcdefghij'));
    assert.deepEqual((await term.visible()).slice(0, 3), ['0123456789', 'abcdefghij', '']);
  });

  it('re-anchors from the parked last row, counting wide characters by cell', async () => {
    const term = emulate(50, 12);
    term.screen.write('above\r\n');
    const region = new LiveRegion(term.screen, 'truecolor', { marginRows: 1 });
    region.start({ row: 2, col: 1 });
    // 44 cells of wide text. At 15 columns only 7 fit on a row (the 8th would straddle the edge),
    // so it takes 4 rows, not the 3 that 44 / 15 suggests.
    region.update(rows('kept'), [row('漢'.repeat(22)), row('status')]);
    await term.flush();
    term.terminal.resize(15, 12);
    region.relayout(await term.cursor());
    region.update([], rows('relaid'));
    const visible = await term.visible();
    assert.deepEqual(visible.slice(0, 3), ['above', 'kept', 'relaid'], visible.join('\n'));
  });

  it('restarts at the parked row, never above it, when there is no cursor report', async () => {
    const term = emulate(40, 10);
    const region = new LiveRegion(term.screen, 'truecolor', { marginRows: 1 });
    region.start({ row: 1, col: 1 });
    region.update(rows('committed'), rows('live 1', 'live 2', 'status'));
    region.relayout(undefined);
    region.update([], rows('after'));
    const visible = await term.visible();
    // Committed text is untouched; the live region restarts on the row the cursor was parked on (the 4th).
    assert.equal(visible[0], 'committed');
    assert.equal(visible.indexOf('after'), 3, visible.join('\n'));
  });
});

describe('rowsNeeded', () => {
  it('counts the rows a terminal wraps text into, by cell', () => {
    assert.equal(rowsNeeded('', 10), 1);
    assert.equal(rowsNeeded('abcdefghij', 10), 1);
    assert.equal(rowsNeeded('abcdefghijk', 10), 2);
    // Five wide characters fit in 10 cells; at 9 the fifth moves whole to the next row.
    assert.equal(rowsNeeded('漢字漢字漢', 10), 1);
    assert.equal(rowsNeeded('漢字漢字漢', 9), 2);
    assert.equal(rowsNeeded('a漢字漢字', 9), 1);
    assert.equal(rowsNeeded('e\u0301'.repeat(10), 10), 1);
  });
});
