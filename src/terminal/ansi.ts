/** Escape sequences Shelly writes to the host terminal. Rows and columns are 1-based. */

const CSI = '\u001b[';

export const ansi = {
  cursorTo: (row: number, col: number): string => `${CSI}${row};${col}H`,
  eraseToLineEnd: `${CSI}K`,
  eraseLine: `${CSI}2K`,
  eraseDown: `${CSI}J`,
  hideCursor: `${CSI}?25l`,
  showCursor: `${CSI}?25h`,
  resetStyle: `${CSI}0m`,
  /** Synchronized output (mode 2026): the terminal presents everything between these at once. */
  beginSynchronizedUpdate: `${CSI}?2026h`,
  endSynchronizedUpdate: `${CSI}?2026l`,
  requestCursorPosition: `${CSI}6n`,
} as const;
