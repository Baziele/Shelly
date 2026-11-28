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
const emulate = (cols: number, height: number, { reflow = true }: { reflow?: boolean } = {}) => {
  // xterm.js does not reflow in its (deprecated) Windows mode.
  const terminal = new xterm.Terminal({ cols, rows: height, allowProposedApi: true, scrollback: 1000, ...(reflow ? {} : { windowsMode: true }) });
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

  it('without a cursor report, counts the rows above the parked one as one row each: never above the live region', async () => {
    const term = emulate(40, 10);
    const region = new LiveRegion(term.screen, 'truecolor', { marginRows: 1 });
    region.start({ row: 1, col: 1 });
    region.update(rows('committed'), rows('live 1', 'live 2', 'status'));
    region.relayout(undefined);
    region.update([], rows('after'));
    const visible = await term.visible();
    // Nothing reflowed here, so that count is exact: the live region is replaced where it was.
    assert.deepEqual(visible.slice(0, 3), ['committed', 'after', ''], visible.join('\n'));
  });
});

describe('LiveRegion re-anchoring when the cursor report is ambiguous', () => {
  // The live rows above the parked one would grow from 2 rows to 6 at 20 columns.
  const setupNearTop = async (reflow = true) => {
    const term = emulate(60, 20, { reflow });
    const region = new LiveRegion(term.screen, 'truecolor', { marginRows: 1 });
    region.start({ row: 1, col: 1 });
    region.update(rows('committed one', 'committed two'), rows('x'.repeat(60), 'y'.repeat(60), 'status'));
    await term.flush();
    return { term, region };
  };

  for (const [label, moved] of [['did not move', 0], ['moved less than the rows above grew', 1]] as const) {
    it(`never erases committed text when the cursor ${label}`, async () => {
      // A terminal that does not reflow, narrowed: the rows above the parked one keep one row each.
      const { term, region } = await setupNearTop(false);
      term.terminal.resize(20, 20);
      // Parked on row 5 (two committed rows, then three live rows); the report says 5 + moved.
      region.relayout({ row: 5 + moved, col: 1 });
      region.update([], rows('repainted'));
      const visible = await term.visible();
      assert.deepEqual(visible.slice(0, 2), ['committed one', 'committed two'], visible.join('\n'));
      // The live region restarts below the committed rows (possibly leaving a stale row: the safe side).
      // In this mode xterm.js keeps cells past the narrowed width, so rows may read back with old text
      // beyond column 20.
      assert.ok(visible.slice(2).some((line) => line.startsWith('repainted')), JSON.stringify(visible));
    });
  }

  it('counts the rewrap when the cursor moved down as far as the rows above grew', async () => {
    const { term, region } = await setupNearTop();
    await term.flush();
    term.terminal.resize(20, 20);
    region.relayout(await term.cursor());
    region.update([], rows('repainted'));
    const visible = await term.visible();
    assert.deepEqual(visible.slice(0, 3), ['committed one', 'committed two', 'repainted'], visible.join('\n'));
  });
});

describe('LiveRegion with an update that reaches the terminal after a resize', () => {
  /*
   * The terminal narrows and reflows while an update written for the old
   * width is still on its way: that update moves up from where the reflow
   * left the cursor by its own count of rows, so it lands below the top of
   * the reflowed live region. Told (acknowledge) that it arrived late,
   * relayout() counts the rows the reflow grew from the update before, and
   * clears from the true top: nothing stale is left, nothing committed goes.
   */
  const lateUpdate = async (first: string) => {
    const term = emulate(80, 20);
    // The size the region knows: the terminal's until the resize reaches it.
    let known = { cols: 80, rows: 20 };
    const screen = { get size() { return known; }, write: term.screen.write };
    const region = new LiveRegion(screen, 'truecolor', { marginRows: 1 });
    region.start({ row: 1, col: 1 });
    const long = (word: string) => `${word} ${'lorem ipsum '.repeat(5).trim()}`;
    region.update(rows('committed one', 'committed two'), rows(long(first), 'status', 'hint'));
    region.acknowledge(80);
    await term.flush();

    term.terminal.resize(40, 20);
    // Written for 80 columns, processed at 40: the second row changed and is long now.
    region.update([], rows(long(first), long('Second'), 'hint'));
    region.acknowledge(40);

    known = { cols: 40, rows: 20 };
    region.relayout(await term.cursor());
    // Repainted at the new width, then committed: what stays in scrollback.
    region.update([], rows(first, 'Second', 'hint'));
    region.update(rows(first, 'Second', 'hint'), []);
    region.finish();
    return (await term.lines()).filter((line) => line !== '');
  };

  it('takes a confirmation of an update that wrote nothing as news of the resize, not of a late update', async () => {
    const term = emulate(80, 20);
    let known = { cols: 80, rows: 20 };
    const screen = { get size() { return known; }, write: term.screen.write };
    const region = new LiveRegion(screen, 'truecolor', { marginRows: 1 });
    region.start({ row: 1, col: 1 });
    const long = `First ${'lorem ipsum '.repeat(5).trim()}`;
    region.update(rows('committed'), rows('First', 'status', 'hint'));
    region.acknowledge(80);
    // The first row grows past 40 columns; the terminal draws it at 80.
    region.update([], rows(long, 'status', 'hint'));
    region.acknowledge(80);
    // Nothing changed: nothing is written, but the view still asks, and the answer comes after the resize.
    region.update([], rows(long, 'status', 'hint'));
    await term.flush();
    term.terminal.resize(40, 20);
    region.acknowledge(40);

    known = { cols: 40, rows: 20 };
    region.relayout(await term.cursor());
    region.update([], rows('First', 'status', 'hint'));
    region.update(rows('First', 'status', 'hint'), []);
    region.finish();
    assert.deepEqual((await term.lines()).filter((line) => line !== ''), ['committed', 'First', 'status', 'hint']);
  });

  it('counts what the late update left stale at the width it arrived at, when the terminal was resized again before relayout()', async () => {
    const term = emulate(80, 20);
    let known = { cols: 80, rows: 20 };
    const screen = { get size() { return known; }, write: term.screen.write };
    const region = new LiveRegion(screen, 'truecolor', { marginRows: 1 });
    region.start({ row: 1, col: 1 });
    const long = (word: string) => `${word} ${'lorem ipsum '.repeat(5).trim()}`;
    region.update(rows('committed one', 'committed two'), rows(long('First'), 'status', 'hint'));
    region.acknowledge(80);
    await term.flush();

    // Narrowed: the update on its way arrives at 40 columns, then the terminal is widened back
    // before the view lays out for either resize.
    // The update rewrites the first row too (the streaming line grew), so it starts on that row.
    term.terminal.resize(40, 20);
    region.update([], rows(`${long('First')} more`, long('Second'), 'hint'));
    region.acknowledge(40);
    await term.flush();
    term.terminal.resize(80, 20);

    region.relayout(await term.cursor());
    region.update([], rows('First', 'Second', 'hint'));
    region.update(rows('First', 'Second', 'hint'), []);
    region.finish();
    assert.deepEqual((await term.lines()).filter((line) => line !== ''), ['committed one', 'committed two', 'First', 'Second', 'hint']);
  });

  it('leaves nothing stale above the live region and keeps committed text', async () => {
    assert.deepEqual(await lateUpdate('First'), ['committed one', 'committed two', 'First', 'Second', 'hint']);
  });
});

describe('LiveRegion when the cursor report cannot tell whether the terminal reflowed', () => {
  /*
   * A reflowing terminal with scrollback, the live region ending above the
   * bottom row: xterm.js scrolls the rewrapped rows up instead of moving the
   * cursor, so the report looks like a terminal that did not reflow.
   */
  const scrolledReflow = async (reflows: boolean | undefined, report: boolean) => {
    const term = emulate(60, 10);
    for (let line = 1; line <= 30; line++) {
      term.screen.write(`history ${line}\r\n`);
    }
    const region = new LiveRegion(term.screen, 'truecolor', { marginRows: 1, reflows });
    region.start(await term.cursor());
    const long = `Streaming ${'words that wrap '.repeat(3).trim()}`;
    region.update(rows('committed'), rows(long, 'second row', 'status', 'hint'));
    // The region shrinks: blank rows below it now, the cursor above the bottom row.
    region.update([], rows(long, 'status'));
    await term.flush();
    term.terminal.resize(30, 10);
    region.relayout(report ? await term.cursor() : undefined);
    region.update([], rows('Streaming', 'status'));
    region.update(rows('Streaming', 'status'), []);
    region.finish();
    return (await term.lines()).filter((line) => line !== '');
  };

  for (const report of [true, false]) {
    it(`clears from the live region's true top in a terminal known to reflow, ${report ? 'whatever the report says' : 'without a report'}`, async () => {
      const lines = await scrolledReflow(true, report);
      assert.deepEqual(lines.slice(-3), ['committed', 'Streaming', 'status'], lines.join('\n'));
      assert.equal(lines.filter((line) => line.startsWith('Streaming')).length, 1, lines.join('\n'));
    });
  }

  it('in a terminal it does not know, never erases committed text (stale live rows may stay: the safe side)', async () => {
    const lines = await scrolledReflow(undefined, true);
    assert.ok(lines.includes('committed'), lines.join('\n'));
    assert.equal(lines.filter((line) => line === 'history 30').length, 1, lines.join('\n'));
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
