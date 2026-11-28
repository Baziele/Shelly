import xterm from '@xterm/headless';
import type { CursorPosition } from '../../src/terminal/cursor-report.js';

/**
 * An in-process terminal (xterm.js) that stands in for the host terminal:
 * whatever is written lands on its screen and in its scrollback, and it
 * answers cursor position queries the way a real one does.
 *
 * This is xterm.js itself, not a model of it: @xterm/headless 6.0.0 is
 * xterm.js's engine (the one VS Code's terminal runs) without a renderer.
 * Resize behaviour is therefore xterm.js's own, and the end-to-end tests
 * (test/tools/scenario.ts) run Shelly in a real pty against the same
 * engine. test/tools/screen.ts only draws this buffer to SVG and PNG for
 * screenshots; it models no terminal behaviour.
 *
 * How xterm.js resizes, next to two other common terminals, as far as the
 * resize tests depend on it (the live region's invariant needs only the
 * first point; see LiveRegion):
 * - Rows above the cursor: xterm.js rewraps every wrapped or overlong line
 *   on narrowing and joins wrapped lines on widening; VTE (GNOME Terminal
 *   and others, since 0.40) and iTerm2 do the same. A line never takes
 *   fewer rows than it has cells to show, so lines printed one row each
 *   take at least as many rows after any resize.
 * - The cursor's own line: xterm.js leaves it as it is (reflowCursorLine is
 *   off by default) and the cursor stays on it; VTE and iTerm2 rewrap it,
 *   and the cursor stays on its cell. Shelly parks in column 1, so either
 *   way the cursor stays on the row that line starts on.
 * - Where the cursor goes: xterm.js moves it down by the rows inserted
 *   above it, or scrolls the screen and keeps its row; with no scrollback
 *   it also counts rows inserted below it (none below a parked live region).
 *   VTE and iTerm2 keep it with its text.
 * - `reflow: false` (xterm.js's Windows mode) stands in for a terminal that
 *   does not rewrap: rows keep their place and are cut at a narrower
 *   width. Unlike a real one, it keeps the cut-off cells out of sight and
 *   shows them again on widening; tests read rows at the visible width.
 */
export class EmulatedTerminal {
  readonly terminal: xterm.Terminal;
  private written = '';

  /** `reflow: false` behaves like a terminal that truncates rows on narrowing instead of rewrapping them. */
  constructor(cols: number, rows: number, { reflow = true }: { reflow?: boolean } = {}) {
    // xterm.js does not reflow in its (deprecated) Windows mode.
    this.terminal = new xterm.Terminal({ cols, rows, allowProposedApi: true, scrollback: 5000, ...(reflow ? {} : { windowsMode: true }) });
  }

  get size(): { cols: number; rows: number } {
    return { cols: this.terminal.cols, rows: this.terminal.rows };
  }

  write = (data: string): void => {
    this.written += data;
    this.terminal.write(data);
  };

  async queryCursorPosition(): Promise<CursorPosition> {
    return this.cursor();
  }

  /** Everything written so far. */
  output(): string {
    return this.written;
  }

  flush(): Promise<void> {
    return new Promise((resolve) => this.terminal.write('', resolve));
  }

  async cursor(): Promise<CursorPosition> {
    await this.flush();
    const buffer = this.terminal.buffer.active;
    return { row: buffer.cursorY + 1, col: buffer.cursorX + 1 };
  }

  /** The visible rows, trailing spaces trimmed. */
  async screen(): Promise<string[]> {
    await this.flush();
    const buffer = this.terminal.buffer.active;
    return Array.from({ length: this.terminal.rows }, (_, row) =>
      buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? '');
  }

  /** Every row, scrollback first, with trailing empty rows dropped. */
  async allLines(): Promise<string[]> {
    await this.flush();
    const buffer = this.terminal.buffer.active;
    const lines = Array.from({ length: buffer.length }, (_, row) => buffer.getLine(row)?.translateToString(true) ?? '');
    while (lines.length > 0 && lines[lines.length - 1] === '') {
      lines.pop();
    }
    return lines;
  }

  /** Logical lines: rows the terminal wrapped are joined back together. */
  async logicalLines(): Promise<string[]> {
    await this.flush();
    const buffer = this.terminal.buffer.active;
    const lines: string[] = [];
    for (let row = 0; row < buffer.length; row++) {
      const line = buffer.getLine(row);
      const text = line?.translateToString(true) ?? '';
      if (line?.isWrapped && lines.length > 0) {
        lines[lines.length - 1] += text;
      } else {
        lines.push(text);
      }
    }
    while (lines.length > 0 && lines[lines.length - 1] === '') {
      lines.pop();
    }
    return lines;
  }

  resize(cols: number, rows: number): void {
    this.terminal.resize(cols, rows);
  }
}
