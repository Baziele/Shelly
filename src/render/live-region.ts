import { ansi } from '../terminal/ansi.js';
import type { CursorPosition } from '../terminal/cursor-report.js';
import { encodeRow, type PaintSpan } from './inline-painter.js';
import type { ColorDepth } from './sgr.js';

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
 * Output that grows downwards from an anchor on the main screen, the way a
 * command's output does. Committed rows are written as ordinary lines, so the
 * terminal scrolls them into its scrollback and they are never touched again.
 * Below them, a live region repaints in place, rewriting only rows that
 * changed.
 *
 * The live region always starts at column 1 of the anchor row, and owns every
 * row from there to the bottom of the screen. Between updates the (hidden)
 * cursor is parked on the anchor, so that after a resize the terminal's
 * cursor report says where the live region now starts.
 */
export class LiveRegion {
  private anchorRow = 1;
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

  /** The screen row the live region starts on. */
  get anchor(): CursorPosition {
    return { row: this.anchorRow, col: 1 };
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
    if (cursor.col <= 1) {
      this.anchorRow = Math.min(cursor.row, rows);
      return;
    }
    // A line feed on the bottom row scrolls, which is what a fresh line there needs.
    this.screen.write(ansi.cursorTo(Math.min(cursor.row, rows), cursor.col) + ansi.resetStyle + '\r\n');
    this.anchorRow = Math.min(cursor.row + 1, rows);
  }

  /**
   * Commit `commit` to scrollback, then show `live` below it, in one
   * synchronized update. `live` taller than `maxLiveRows` keeps its tail.
   */
  update(commit: readonly PaintRow[], live: readonly PaintRow[]): void {
    if (!this.started) {
      return;
    }
    const { rows } = this.screen.size;
    let output = ansi.beginSynchronizedUpdate + ansi.hideCursor;

    if (commit.length > 0) {
      output += ansi.cursorTo(this.anchorRow, 1);
      for (const row of commit) {
        // Erase first: erasing after a row that fills the width would clear its last cell on some terminals.
        output += ansi.resetStyle + ansi.eraseLine + encodeRow(row, this.colorDepth) + ansi.resetStyle + '\r\n';
      }
      this.anchorRow = Math.min(this.anchorRow + commit.length, rows);
      // Whatever the live region left below the committed rows is stale now.
      output += ansi.resetStyle + ansi.eraseDown;
      this.painted = [];
    }

    const shown = live.length > this.maxLiveRows ? live.slice(live.length - this.maxLiveRows) : live;
    const overflow = this.anchorRow + shown.length - 1 - rows;
    if (overflow > 0) {
      // Scroll the screen up to make room; only rows above the live region leave it.
      output += ansi.resetStyle + ansi.cursorTo(rows, 1) + '\n'.repeat(overflow);
      this.anchorRow -= overflow;
      this.painted = [];
    }

    const encoded = shown.map((row) => encodeRow(row, this.colorDepth));
    encoded.forEach((content, index) => {
      if (this.painted[index] === content) {
        return;
      }
      output += ansi.cursorTo(this.anchorRow + index, 1) + ansi.resetStyle + ansi.eraseLine + content + ansi.resetStyle;
    });
    for (let index = encoded.length; index < this.painted.length; index++) {
      output += ansi.cursorTo(this.anchorRow + index, 1) + ansi.eraseLine;
    }
    this.painted = encoded;

    output += ansi.cursorTo(this.anchorRow, 1) + ansi.endSynchronizedUpdate;
    this.screen.write(output);
  }

  /**
   * Re-anchor after a resize. `cursor` is where the terminal now reports the
   * cursor, which was parked on the live region's first row. The old live
   * rows are erased; the caller repaints at the new width with `update`.
   */
  relayout(cursor: CursorPosition): void {
    if (!this.started) {
      return;
    }
    this.anchorRow = Math.min(Math.max(1, cursor.row), this.screen.size.rows);
    this.painted = [];
    this.screen.write(ansi.cursorTo(this.anchorRow, 1) + ansi.resetStyle + ansi.eraseDown);
  }

  /** Erase the live region and leave a visible cursor at its start: a fresh line below everything committed. */
  finish(): void {
    if (!this.started) {
      return;
    }
    this.started = false;
    this.painted = [];
    this.screen.write(
      ansi.beginSynchronizedUpdate + ansi.cursorTo(this.anchorRow, 1) + ansi.resetStyle + ansi.eraseDown
        + ansi.showCursor + ansi.endSynchronizedUpdate,
    );
  }
}
