/** A 1-based cell position on the terminal screen. */
export interface CursorPosition {
  readonly row: number;
  readonly col: number;
}

/*
 * Shelly asks with both CSI ? 6 n (DECXCPR) and CSI 6 n. A terminal that knows
 * the DEC form answers CSI ? row ; col [; page] R first, which no key sends;
 * the plain answer, CSI row ; col R, is also what F3 with a modifier sends
 * (Shift+F3 is CSI 1 ; 2 R), so a plain report shaped like that is ambiguous.
 */
const CURSOR_POSITION_REPORT = /\u001b\[(\?)?(\d+);(\d+)(?:;\d+)?R/;

export interface ExtractedCursorReport {
  readonly position: CursorPosition;
  /** `dec`: the DEC form, which only a terminal sends. `plain`: CSI row ; col R. */
  readonly kind: 'dec' | 'plain';
  /** A plain report that could also be F3 with a modifier (row 1, column 2–8). */
  readonly ambiguous: boolean;
  /** The input with the report removed: keystrokes that arrived alongside it. */
  readonly remaining: string;
  /** Input before the report, and after it. */
  readonly before: string;
  readonly after: string;
}

/** Find and remove the first cursor position report in raw terminal input. */
export const extractCursorReport = (input: string): ExtractedCursorReport | undefined => {
  const match = CURSOR_POSITION_REPORT.exec(input);
  if (!match) {
    return undefined;
  }
  const kind = match[1] ? 'dec' : 'plain';
  const position = { row: Number(match[2]), col: Number(match[3]) };
  const before = input.slice(0, match.index);
  const after = input.slice(match.index + match[0].length);
  return {
    position,
    kind,
    ambiguous: kind === 'plain' && position.row === 1 && position.col >= 2 && position.col <= 8,
    remaining: before + after,
    before,
    after,
  };
};

/** Remove up to `count` cursor position reports from `input`. */
export const dropCursorReports = (input: string, count: number): { text: string; dropped: number } => {
  let text = input;
  let dropped = 0;
  while (dropped < count) {
    const report = extractCursorReport(text);
    if (!report) {
      break;
    }
    text = report.remaining;
    dropped++;
  }
  return { text, dropped };
};
