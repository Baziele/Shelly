import xterm from '@xterm/headless';
import type { CursorPosition } from '../../src/terminal/cursor-report.js';

/**
 * An in-process terminal (xterm.js) that stands in for the host terminal:
 * whatever is written lands on its screen and in its scrollback, and it
 * answers cursor position queries the way a real one does.
 */
export class EmulatedTerminal {
  readonly terminal: xterm.Terminal;
  private written = '';

  constructor(cols: number, rows: number) {
    this.terminal = new xterm.Terminal({ cols, rows, allowProposedApi: true, scrollback: 5000 });
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
