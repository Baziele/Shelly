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
 * Output that grows downwards from an anchor on the main screen, the way a
 * command's output does. Committed rows are written as ordinary lines, so the
 * terminal scrolls them into its scrollback and they are never touched again.
 * Below them, a live region repaints in place.
 *
 * The live region owns every row from its first to the bottom of the screen.
 * Between updates the (hidden) cursor is parked in column 1 of its last row,
 * and every move is relative to it: up to the first row that changed, then
 * down only by writing rows. No absolute position is ever used, because the
 * terminal may have resized and reflowed the screen before an update written
 * for the old size reaches it: such an update then lands inside the live
 * region (whose rows only got taller) and never on committed text. After a
 * resize, relayout() moves up from the parked row by the height the rows
 * above it reflowed to, and clears from there. Which rows those were
 * depends on whether the last update reached the terminal before the resize
 * or after: see acknowledge().
 */
export class LiveRegion {
  private anchorRow = 1;
  /** The text of each live row above the parked one, for working out where they went after a reflow. */
  private textAbovePark: string[] = [];
  /** The same for the update before, which is what a terminal reflowed if the last one reached it after a resize. */
  private previousTextAbovePark: string[] = [];
  /** The width the last update was drawn for. */
  private writtenCols = 0;
  /** The terminal reached the last update only after it was resized (see acknowledge()). */
  private lastArrivedLate = false;
  /** The screen row the cursor was parked on. */
  private parkedRow = 1;
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

  /** Live rows above the one the cursor is parked on: what a reflow can make taller. */
  get rowsAbovePark(): number {
    return this.textAbovePark.length;
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
      this.parkedRow = this.anchorRow;
      return;
    }
    // A line feed on the bottom row scrolls, which is what a fresh line there needs.
    this.screen.write(ansi.cursorTo(Math.min(cursor.row, rows), cursor.col) + ansi.resetStyle + '\r\n');
    this.anchorRow = Math.min(cursor.row + 1, rows);
    this.parkedRow = this.anchorRow;
  }

  /**
   * Commit `commit` to scrollback, then show `live` below it, in one
   * synchronized update. `live` taller than `maxLiveRows` keeps its tail.
   * `hold` leaves the synchronized update open, for the next update to
   * finish: the terminal shows neither half on its own.
   */
  update(commit: readonly PaintRow[], live: readonly PaintRow[], { hold = false }: { readonly hold?: boolean } = {}): void {
    if (!this.started) {
      return;
    }
    const { rows } = this.screen.size;
    const shown = live.length > this.maxLiveRows ? live.slice(live.length - this.maxLiveRows) : live;
    const encoded = shown.map((row) => encodeRow(row, this.colorDepth));

    // The first live row to write: the top when committing, else the first that changed. Every row
    // from there down is written again, so the cursor only ever moves down by writing (see the class
    // comment).
    let first = 0;
    if (commit.length === 0) {
      while (first < encoded.length && first < this.painted.length && encoded[first] === this.painted[first]) {
        first++;
      }
      if (first === encoded.length && encoded.length === this.painted.length) {
        return;
      }
      first = Math.min(first, Math.max(0, encoded.length - 1));
    }

    const parkIndex = Math.max(0, this.painted.length - 1);
    const top = this.parkedRow - parkIndex;
    let output = ansi.beginSynchronizedUpdate + ansi.hideCursor;
    const up = parkIndex - first;
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
    // live row is one terminal row and the parked cursor is where relayout() expects. It is drawn
    // again at the new width moments later. Committed rows keep autowrap: they are never cut.
    output += ansi.autowrapOff;
    encoded.slice(first).forEach((content, index, written) => {
      output += content + ansi.resetStyle + (index < written.length - 1 ? '\r\n' : '');
    });
    // Parked in column 1 of the last live row (or on the fresh line after the committed rows).
    output += '\r' + ansi.autowrapOn + (hold ? '' : ansi.endSynchronizedUpdate);
    this.screen.write(output);

    // Where that left things on screen, for re-anchoring after a resize. Writing past the bottom row
    // scrolls the screen, so the top is wherever the rows written end, counted up from there.
    const newTop = top + commit.length;
    const bottom = newTop + Math.max(0, encoded.length - 1);
    this.anchorRow = Math.max(1, newTop - Math.max(0, bottom - rows));
    this.painted = encoded;
    const last = Math.max(0, shown.length - 1);
    this.previousTextAbovePark = this.textAbovePark;
    this.textAbovePark = shown.slice(0, last).map(rowText);
    this.parkedRow = this.anchorRow + last;
    this.writtenCols = this.screen.size.cols;
    this.lastArrivedLate = false;
  }

  /**
   * The terminal reports it drew the last update at `cols` columns. Another
   * width than it was written for means the update reached the terminal
   * after a resize (it was on its way when the terminal reflowed): what the
   * terminal reflowed was then the update before, and relayout() counts that
   * one's rows. A caller that waits for this before each next update knows,
   * at any resize, exactly which update the terminal reflowed.
   */
  acknowledge(cols: number): void {
    if (this.started) {
      this.lastArrivedLate = cols !== this.writtenCols;
    }
  }

  /**
   * Re-anchor after a resize. `cursor` is where the terminal now reports the
   * cursor, which was parked in column 1 of the live region's last row; the
   * old live rows are erased and the caller repaints at the new width.
   *
   * A terminal that reflows rewraps the live rows above the parked one, and
   * the cursor moves down with them; one that does not reflow leaves the
   * cursor where it was. Only when the cursor moved down at least as far as
   * those rows grew (or sits on the bottom row, where content scrolls
   * instead) is the rewrap counted; otherwise the rows above count one row
   * each, which may leave stale rows but never paints over committed text.
   * (A terminal that does not reflow, with the region on the bottom row, is
   * the one case still taken as reflowing.)
   *
   * Without a report (`undefined`), the live region restarts at the row the
   * cursor was parked on: it may leave stale rows above, but it never moves
   * up onto committed text.
   */
  relayout(cursor: CursorPosition | undefined): void {
    if (!this.started) {
      return;
    }
    const { cols, rows } = this.screen.size;
    // The rows the terminal reflowed: the last update's, or the one before when the last arrived
    // after the resize. That one moved up from where the reflow left the cursor by its own count of
    // rows and drew one row each (without autowrap), so the rows above the cursor are its own plus
    // however much the reflow grew the earlier ones. Either way: this update's rows plus that growth.
    const reflowedRows = this.lastArrivedLate ? this.previousTextAbovePark : this.textAbovePark;
    const grown = reflowedRows.reduce((sum, text) => sum + rowsNeeded(text, cols), 0) - reflowedRows.length;
    // Rewrapping pushes the cursor down at least as far as the rows above it grew, unless it is on
    // the bottom row (where the terminal scrolls content up instead). Anything less, or no report,
    // is ambiguous, and then the count that cannot reach committed text wins: at worst it leaves
    // stale rows above.
    const reflowed = cursor !== undefined && (grown === 0 || cursor.row - this.parkedRow >= grown || cursor.row >= rows);
    const above = this.textAbovePark.length + (reflowed ? grown : 0);
    // Up from where the terminal kept the cursor (the parked row, wherever its reflow put it), not to
    // a computed row: a frame drawn before the resize reached the terminal may have moved things.
    // Ends a synchronized update an update may have left open (see update()).
    this.screen.write((above > 0 ? ansi.cursorUp(above) : '') + '\r' + ansi.resetStyle + ansi.eraseDown + ansi.endSynchronizedUpdate);
    this.anchorRow = Math.min(Math.max(1, (cursor?.row ?? this.parkedRow) - above), rows);
    this.parkedRow = this.anchorRow;
    this.textAbovePark = [];
    this.previousTextAbovePark = [];
    this.lastArrivedLate = false;
    this.painted = [];
  }

  /** Erase the live region and leave a visible cursor at its start: a fresh line below everything committed. */
  finish(): void {
    if (!this.started) {
      return;
    }
    this.started = false;
    const up = Math.max(0, this.painted.length - 1);
    this.painted = [];
    this.screen.write(
      ansi.beginSynchronizedUpdate + (up > 0 ? ansi.cursorUp(up) : '') + '\r' + ansi.resetStyle + ansi.eraseDown
        + ansi.showCursor + ansi.endSynchronizedUpdate,
    );
  }
}

/** A row's text, trailing blanks left out: what a terminal rewraps. */
const rowText = (row: PaintRow): string => row.map((span) => span.text).join('').replace(/ +$/, '');

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
