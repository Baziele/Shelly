/** A 1-based cell position on the terminal screen. */
export interface CursorPosition {
  readonly row: number;
  readonly col: number;
}

// The terminal answers a cursor position request (CSI 6n) with CSI <row> ; <col> R.
const CURSOR_POSITION_REPORT = /\u001b\[(\d+);(\d+)R/;

export interface ExtractedCursorReport {
  readonly position: CursorPosition;
  /** The input with the report removed: keystrokes that arrived alongside it. */
  readonly remaining: string;
}

/** Find and remove a cursor position report from raw terminal input. */
export const extractCursorReport = (input: string): ExtractedCursorReport | undefined => {
  const match = CURSOR_POSITION_REPORT.exec(input);
  if (!match) {
    return undefined;
  }

  return {
    position: { row: Number(match[1]), col: Number(match[2]) },
    remaining: input.slice(0, match.index) + input.slice(match.index + match[0].length),
  };
};
