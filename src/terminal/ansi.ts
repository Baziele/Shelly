/** Escape sequences Shelly writes to the host terminal. Rows and columns are 1-based. */

const CSI = '\u001b[';

export const ansi = {
  cursorTo: (row: number, col: number): string => `${CSI}${row};${col}H`,
  eraseToLineEnd: `${CSI}K`,
  eraseLine: `${CSI}2K`,
  eraseDown: `${CSI}J`,
  /** DECAWM: whether text reaching the right edge wraps to the next row. */
  autowrapOff: `${CSI}?7l`,
  autowrapOn: `${CSI}?7h`,
  /** Up `rows` rows, staying in the column; stops at the top row. */
  cursorUp: (rows: number): string => `${CSI}${rows}A`,
  /** Right `cols` columns, staying on the row; stops at the right edge. */
  cursorForward: (cols: number): string => `${CSI}${cols}C`,
  hideCursor: `${CSI}?25l`,
  showCursor: `${CSI}?25h`,
  resetStyle: `${CSI}0m`,
  /** Synchronized output (mode 2026): the terminal presents everything between these at once. */
  beginSynchronizedUpdate: `${CSI}?2026h`,
  endSynchronizedUpdate: `${CSI}?2026l`,
  requestCursorPosition: `${CSI}6n`,
  /** DECXCPR: answered as CSI ? row ; col R, which no key sends (see cursor-report.ts). */
  requestDecCursorPosition: `${CSI}?6n`,
} as const;
