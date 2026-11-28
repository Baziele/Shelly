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

  it('clears the live region where it is and repaints it after relayout(), asking the terminal nothing', async () => {
    const term = emulate(40, 10);
    const region = new LiveRegion(term.screen, 'truecolor', { marginRows: 1 });
    region.start({ row: 1, col: 1 });
    region.update(rows('committed'), rows('live 1', 'live 2', 'status'));
    region.relayout();
    region.update([], rows('after'));
    const visible = await term.visible();
    assert.deepEqual(visible.slice(0, 3), ['committed', 'after', ''], visible.join('\n'));
    assert.ok(!term.written().includes('6n'), 'asked the terminal something');
  });

  it('keeps a full-width row intact', async () => {
    const term = emulate(10, 4);
    const region = new LiveRegion(term.screen, 'truecolor');
    region.start({ row: 1, col: 1 });
    region.update(rows('0123456789'), rows('abcdefghij'));
    assert.deepEqual((await term.visible()).slice(0, 3), ['0123456789', 'abcdefghij', '']);
  });

  it('writes the rows after the parked one below it when the region grows', async () => {
    const term = emulate(20, 8);
    const region = new LiveRegion(term.screen, 'truecolor', { marginRows: 1 });
    region.start({ row: 1, col: 1 });
    region.update([], rows('a', 'b'));
    region.update([], rows('a', 'b', 'c', 'd'));
    assert.deepEqual((await term.visible()).slice(0, 5), ['a', 'b', 'c', 'd', '']);
  });
});

/**
 * The terminal's rows joined back into the lines that were written (rows it
 * wrapped itself belong together), each row as far as the screen shows it
 * (xterm.js's non-reflowing mode keeps cells past a narrowed width, out of sight).
 */
const logicalLines = (terminal: xterm.Terminal): string[] => {
  const buffer = terminal.buffer.active;
  const lines: string[] = [];
  for (let index = 0; index < buffer.length; index++) {
    const line = buffer.getLine(index);
    const text = (line?.translateToString(true, 0, terminal.cols) ?? '').trimEnd();
    if (line?.isWrapped && lines.length > 0) {
      lines[lines.length - 1] += text;
    } else {
      lines.push(text);
    }
  }
  while (lines.length > 0 && lines.at(-1) === '') {
    lines.pop();
  }
  return lines;
};

describe('LiveRegion through a resize', () => {
  /*
   * The invariants, in a terminal that rewraps rows and in one that does
   * not, with and without an update written for the old width reaching the
   * terminal after the resize:
   * - every committed line stays, exactly as written, in order;
   * - nothing is lost;
   * - at most the rows that were live when the resize came show twice (the
   *   top of a live row the terminal rewrapped).
   */
  const committed = ['history 1', 'history 2', `committed ${'x'.repeat(48)}`, 'committed short'];
  const liveRow = `live ${'y'.repeat(50)}`;

  for (const reflow of [true, false]) {
    for (const inFlight of [false, true]) {
      it(`${reflow ? 'rewrapping' : 'not rewrapping'}${inFlight ? ', with an update on its way' : ''}: committed lines stay, nothing is lost, at most the live rows show twice`, async () => {
        const term = emulate(60, 16, { reflow });
        const region = new LiveRegion(term.screen, 'truecolor', { marginRows: 1 });
        region.start({ row: 1, col: 1 });
        region.update(rows(...committed), rows(liveRow, 'status'));
        await term.flush();
        const liveAtResize = 2;

        term.terminal.resize(30, 16);
        // Written for 60 columns, drawn at 30: it commits the live row and shows the next.
        const late = inFlight ? [liveRow] : [];
        if (inFlight) {
          region.update(rows(liveRow), rows(`next ${'z'.repeat(40)}`, 'status'));
        }
        region.relayout();
        region.update([], rows('next', 'status'));
        region.update(rows('next', 'done'), []);
        region.finish();

        await term.flush();
        const lines = logicalLines(term.terminal);
        // A terminal that does not rewrap cuts the rows that were on screen at the new width.
        const expected = [...committed.map((line) => (reflow ? line : line.slice(0, 30))), ...late, 'next', 'done'];
        // Every committed line, whole and in order (the terminal may have rewrapped them; joined back, they are as written).
        let from = 0;
        for (const line of expected) {
          const at = lines.indexOf(line, from);
          assert.ok(at >= 0, `${JSON.stringify(line)} lost or changed:\n${lines.join('\n')}`);
          from = at + 1;
        }
        const extra = lines.filter((line) => !expected.includes(line));
        assert.ok(extra.length <= liveAtResize, `more than the live rows show twice:\n${lines.join('\n')}`);
        for (const line of extra) {
          assert.ok(liveRow.startsWith(line) || `next ${'z'.repeat(40)}`.startsWith(line) || 'status'.startsWith(line),
            `${JSON.stringify(line)} is not part of a row that was live:\n${lines.join('\n')}`);
        }
        if (!reflow) {
          assert.deepEqual(extra, [], 'a terminal that does not rewrap leaves nothing behind');
        }
      });
    }
  }

  it('counts wide characters by cell, and leaves committed text alone', async () => {
    const term = emulate(50, 12);
    term.screen.write('above\r\n');
    const region = new LiveRegion(term.screen, 'truecolor', { marginRows: 1 });
    region.start({ row: 2, col: 1 });
    region.update(rows('kept'), [row('漢'.repeat(22)), row('status')]);
    await term.flush();
    term.terminal.resize(15, 12);
    region.relayout();
    region.update([], rows('relaid'));
    await term.flush();
    const lines = logicalLines(term.terminal);
    assert.deepEqual(lines.slice(0, 2), ['above', 'kept'], lines.join('\n'));
    assert.equal(lines.at(-1), 'relaid');
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
