import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import xterm from '@xterm/headless';
import { drawBelowLine, eraseBelowLine } from './below-line.js';

/** A terminal showing `rows`, cursor at `cursor`, after `output`. */
const run = async (size: { cols: number; rows: number }, rows: string[], cursor: { row: number; col: number }, output: string) => {
  const terminal = new xterm.Terminal({ cols: size.cols, rows: size.rows, allowProposedApi: true });
  const write = (data: string) => new Promise<void>((resolve) => terminal.write(data, resolve));
  await write(rows.join('\r\n') + `\u001b[${cursor.row};${cursor.col}H` + output);
  const buffer = terminal.buffer.active;
  const lines = Array.from({ length: size.rows }, (_, index) => buffer.getLine(buffer.viewportY + index)?.translateToString(true) ?? '');
  return { lines, cursor: { row: buffer.cursorY + 1, col: buffer.cursorX + 1 }, write, terminal };
};

describe('drawBelowLine', () => {
  it('draws below the line, leaves the cursor where it was, and erases cleanly', async () => {
    const { output, notice } = drawBelowLine('needs bash 4', { row: 2, col: 12 }, { cols: 20, rows: 5 });
    const screen = await run({ cols: 20, rows: 5 }, ['$ ls', '$ echo half'], { row: 2, col: 8 }, output);
    assert.deepEqual(screen.lines, ['$ ls', '$ echo half', 'needs bash 4', '', '']);
    assert.deepEqual(screen.cursor, { row: 2, col: 12 }, 'on the end, where the shell put it');
    assert.deepEqual(notice, { firstRow: 3, rows: 1 });
    await screen.write(`\u001b[2;8H${eraseBelowLine(notice)}`);
    const buffer = screen.terminal.buffer.active;
    assert.equal(buffer.getLine(2)?.translateToString(true), '');
    assert.deepEqual({ row: buffer.cursorY + 1, col: buffer.cursorX + 1 }, { row: 2, col: 8 }, 'the cursor stays put');
  });

  it('wraps on a narrow screen, keeps to the rows it can spare, and scrolls the line up with it', async () => {
    const size = { cols: 10, rows: 4 };
    const { output, notice } = drawBelowLine('needs bash 4 or newer to read it, really', { row: 4, col: 8 }, size);
    const screen = await run(size, ['a', 'b', 'c', '$ echo x'], { row: 4, col: 3 }, output);
    assert.deepEqual(screen.lines, ['$ echo x', 'needs bash', '4 or newer', 'to read'], 'between words');
    assert.deepEqual(notice, { firstRow: 2, rows: 3 });
    assert.deepEqual(screen.cursor, { row: 1, col: 8 });
  });
});
