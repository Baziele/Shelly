import { ansi } from '../terminal/ansi.js';
import type { CursorPosition } from '../terminal/cursor-report.js';
import { encodeRow, type PaintSpan } from './inline-painter.js';
import type { ColorDepth } from './sgr.js';
import { graphemeWidth } from './text-width.js';

export type PaintRow = ReadonlyArray<PaintSpan>;

/** The part of the host terminal a live region needs. */
export interface LiveRegionScreen {
  readonly size: { readonly cols: number; readonly rows: number };
  write(data: string): void;
}

export interface LiveRegionOptions {
  /** Rows kept free above the live region so the user always sees some context. */
  readonly marginRows?: number;
}

/**
 * Output that grows downwards from where it starts on the main screen, the
 * way a command's output does. Committed rows are written as ordinary lines,
 * so the terminal scrolls them into its scrollback, and nothing ever moves
 * onto them again. Below them, a small live region repaints in place.
 *
 * The live region owns every row from its first to the bottom of the screen.
 * Between updates the (hidden) cursor is parked in column 1 of its last row,
 * and every move is relative to it: up by at most the rows the region
 * printed above it, then down only by writing rows. No absolute position is
 * ever used and no answer from the terminal is waited for.
 *
 * Why that never reaches committed text: a terminal that is resized
 * rewraps rows (most do) or leaves them as they are; either way the rows
 * above the cursor take at least as many rows as were printed, and the
 * cursor stays on its row. So moving up by the printed count always lands
 * inside the live region, even for an update written before a resize and
 * drawn after it. Live rows are written without autowrap, so each takes
 * exactly one row however wide the terminal turns out to be.
 *
 * The price: where a terminal rewrapped live rows, the top of the taller
 * rows can stay behind above the region after a resize (a fragment of a
 * row that was live then). The caller keeps the region small, so that is a
 * row or two at most.
 */
export class LiveRegion {
  /** The number of live rows above the parked one, as printed. */
  private rowsAbove = 0;
  private painted: string[] = [];
  private started = false;
  private readonly marginRows: number;

  constructor(
    private readonly screen: LiveRegionScreen,
    private readonly colorDepth: ColorDepth,
    options: LiveRegionOptions = {},
  ) {
    this.marginRows = options.marginRows ?? 2;
  }

  /** Tallest the live region may get; taller content must be clipped by the caller. */
  get maxLiveRows(): number {
    return Math.max(1, this.screen.size.rows - this.marginRows);
  }

  /** Rows currently painted in the live region. */
  get liveRowCount(): number {
    return this.painted.length;
  }

  /**
   * Begin at `cursor`. Output starts on that row when the cursor is in the
   * first column, otherwise on the row below it.
   */
  start(cursor: CursorPosition): void {
    const { rows } = this.screen.size;
    this.started = true;
    this.painted = [];
    this.rowsAbove = 0;
    if (cursor.col > 1) {
      // A line feed on the bottom row scrolls, which is what a fresh line there needs.
      this.screen.write(ansi.cursorTo(Math.min(cursor.row, rows), cursor.col) + ansi.resetStyle + '\r\n');
    }
  }

  /**
   * Commit `commit` to scrollback, then show `live` below it, in one
   * synchronized update. `live` taller than `maxLiveRows` keeps its tail.
   */
  update(commit: readonly PaintRow[], live: readonly PaintRow[]): void {
    if (!this.started) {
      return;
    }
    const shown = live.length > this.maxLiveRows ? live.slice(live.length - this.maxLiveRows) : live;
    const encoded = shown.map((row) => encodeRow(row, this.colorDepth));

    // The first live row to write: the top when committing, else the first that changed. Every row
    // from there down is written again, so the cursor only ever moves down by writing.
    let first = 0;
    if (commit.length === 0) {
      while (first < encoded.length && first < this.painted.length && encoded[first] === this.painted[first]) {
        first++;
      }
      if (first === encoded.length && encoded.length === this.painted.length) {
        return;
      }
      // No further down than the parked row: the cursor is there, and rows are only written downwards.
      first = Math.min(first, Math.max(0, encoded.length - 1), this.rowsAbove);
    }

    let output = ansi.beginSynchronizedUpdate + ansi.hideCursor;
    const up = this.rowsAbove - first;
    if (up > 0) {
      output += ansi.cursorUp(up);
    }
    // Everything from here down is the live region's: clear it, then write.
    output += '\r' + ansi.resetStyle + ansi.eraseDown;
    for (const row of commit) {
      output += encodeRow(row, this.colorDepth) + ansi.resetStyle + '\r\n';
    }
    // Live rows are written without autowrap: one written for a wider terminal than it lands in (the
    // terminal was resized while it was on its way) is cut at the edge instead of wrapping, so each
    // live row is one terminal row, as the next update counts it. It is drawn again at the new width
    // moments later. Committed rows keep autowrap: they are never cut.
    output += ansi.autowrapOff;
    encoded.slice(first).forEach((content, index, written) => {
      output += content + ansi.resetStyle + (index < written.length - 1 ? '\r\n' : '');
    });
    // Parked in column 1 of the last live row (or on the fresh line after the committed rows).
    output += '\r' + ansi.autowrapOn + ansi.endSynchronizedUpdate;
    this.screen.write(output);
    this.painted = encoded;
    this.rowsAbove = Math.max(0, encoded.length - 1);
  }

  /**
   * After a resize: clear the live region so the caller repaints it at the
   * new width. Moves up by the live rows above the cursor as they were
   * printed, the fewest rows they can take now, so committed text is never
   * reached; if the terminal rewrapped them taller, the top of them stays
   * behind (see the class comment). Needs nothing from the terminal.
   */
  relayout(): void {
    if (!this.started) {
      return;
    }
    this.screen.write(
      (this.rowsAbove > 0 ? ansi.cursorUp(this.rowsAbove) : '') + '\r' + ansi.resetStyle + ansi.eraseDown
        + ansi.autowrapOn + ansi.endSynchronizedUpdate,
    );
    this.rowsAbove = 0;
    this.painted = [];
  }

  /** Erase the live region and leave a visible cursor at its start: a fresh line below everything committed. */
  finish(): void {
    if (!this.started) {
      return;
    }
    this.started = false;
    const up = this.rowsAbove;
    this.painted = [];
    this.rowsAbove = 0;
    this.screen.write(
      ansi.beginSynchronizedUpdate + (up > 0 ? ansi.cursorUp(up) : '') + '\r' + ansi.resetStyle + ansi.eraseDown
        + ansi.showCursor + ansi.endSynchronizedUpdate,
    );
  }
}

/**
 * Rows `text` takes when a terminal wraps it at `cols`, counting cells as
 * the terminal does: a wide character that does not fit at the end of a row
 * moves whole to the next.
 */
export const rowsNeeded = (text: string, cols: number): number => {
  let rowsUsed = 1;
  let col = 0;
  for (const { segment } of graphemes.segment(text)) {
    const width = graphemeWidth(segment);
    if (width === 0) {
      continue;
    }
    if (col + width > cols) {
      rowsUsed++;
      col = 0;
    }
    col += width;
  }
  return rowsUsed;
};

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
