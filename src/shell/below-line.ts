import type { CursorPosition } from '../terminal/cursor-report.js';
import type { TerminalSize } from '../terminal/host-terminal.js';

/*
 * A short notice Shelly draws itself on the rows below the shell's input
 * line, for bash 3.2, which cannot show one (its bind -x cannot run a
 * command for a key as long as Shelly's private ones). The shell never
 * knows it is there, so nothing of its line needs redrawing: the notice is
 * erased before the next key reaches the shell, as zsh's `zle -M` would.
 */

/** Rows Shelly drew a notice on. */
export interface BelowLineNotice {
  readonly firstRow: number;
  readonly rows: number;
}

const DIM = '\u001b[2m';
const RESET = '\u001b[0m';
const ERASE_DOWN = '\u001b[J';
const ERASE_LINE = '\u001b[2K';
const SAVE_CURSOR = '\u001b7';
const RESTORE_CURSOR = '\u001b8';
const cursorTo = (row: number, col: number): string => `\u001b[${row};${col}H`;

/**
 * Draw `text` (printable ASCII) from the row below `end`, where the
 * shell's line ends, scrolling the screen up if there is no room, and leave
 * the cursor on `end` (moved up with the scroll).
 */
export const drawBelowLine = (
  text: string,
  end: CursorPosition,
  size: TerminalSize,
): { readonly output: string; readonly notice: BelowLineNotice } => {
  const lines = wrapWords(text, Math.max(1, size.cols)).slice(0, Math.max(1, size.rows - 1));
  const rows = lines.length;
  // From the bottom row, each line feed scrolls the screen, the line with it.
  const scrolled = Math.max(0, end.row + rows - size.rows);
  const row = end.row - scrolled;
  // Below the line's end there is nothing of the shell's: clear it first.
  const output = `\r\n${ERASE_DOWN}${DIM}${lines.join('\r\n')}${RESET}${cursorTo(row, end.col)}`;
  return { output, notice: { firstRow: row + 1, rows } };
};

/** `text` in rows of at most `cols`, broken between words where it can be. */
const wrapWords = (text: string, cols: number): string[] => {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(' ').filter(Boolean)) {
    const joined = line ? `${line} ${word}` : word;
    if (joined.length <= cols) {
      line = joined;
      continue;
    }
    if (line) {
      lines.push(line);
    }
    line = word;
    while (line.length > cols) {
      lines.push(line.slice(0, cols));
      line = line.slice(cols);
    }
  }
  return line ? [...lines, line] : lines;
};

/** Erase a notice, leaving the cursor where it is. */
export const eraseBelowLine = (notice: BelowLineNotice): string => {
  let output = SAVE_CURSOR;
  for (let row = notice.firstRow; row < notice.firstRow + notice.rows; row++) {
    output += cursorTo(row, 1) + ERASE_LINE;
  }
  return output + RESTORE_CURSOR;
};
