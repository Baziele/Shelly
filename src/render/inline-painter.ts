import { ansi } from '../terminal/ansi.js';
import type { CursorPosition } from '../terminal/cursor-report.js';
import { hasCellControls, stripCellControls } from './sanitize.js';
import { isBlankStyle, styleToSgr, type CellStyle, type ColorDepth } from './sgr.js';

/** A run of identically styled cells. */
export interface PaintSpan {
  readonly text: string;
  /** Width in terminal cells. */
  readonly width: number;
  readonly style: CellStyle;
}

export interface PaintFrame {
  /** The rows to show, top to bottom. Frame column N lands on screen column N. */
  readonly rows: ReadonlyArray<ReadonlyArray<PaintSpan>>;
  /** 1-based, in frame coordinates. */
  readonly cursor: { readonly row: number; readonly col: number; readonly visible: boolean };
}

/**
 * Paints frames into a region of the main screen whose top-left cell is the
 * anchor. The first row starts at the anchor's column so whatever sits to its
 * left (the shell prompt) is never touched; later rows span the full width.
 *
 * The painter only produces escape sequences. It remembers what it painted so
 * each frame rewrites only the rows that changed.
 */
export class InlinePainter {
  private painted: string[] = [];

  constructor(private readonly colorDepth: ColorDepth) {}

  paint(frame: PaintFrame, anchor: CursorPosition): string {
    let output = this.paintRows(frame.rows, anchor);

    const { cursor } = frame;
    output += ansi.cursorTo(anchor.row + cursor.row - 1, cursor.col);
    output += cursor.visible ? ansi.showCursor : '';

    return ansi.beginSynchronizedUpdate + ansi.hideCursor + output + ansi.endSynchronizedUpdate;
  }

  /**
   * The rows alone: no synchronized-update wrapper and no cursor placement,
   * for callers that combine them with other output in one update.
   */
  paintRows(rows: PaintFrame['rows'], anchor: CursorPosition): string {
    let output = '';

    rows.forEach((spans, index) => {
      const startCol = index === 0 ? anchor.col : 1;
      const content = encodeRow(spans, this.colorDepth, startCol - 1);
      if (this.painted[index] === content) {
        return;
      }
      output += ansi.cursorTo(anchor.row + index, startCol) + content + ansi.resetStyle + ansi.eraseToLineEnd;
      this.painted[index] = content;
    });

    for (let index = rows.length; index < this.painted.length; index++) {
      output += ansi.cursorTo(anchor.row + index, 1) + ansi.eraseLine;
    }
    this.painted.length = Math.min(this.painted.length, rows.length);

    return output;
  }

  /** Erase everything from the anchor down and leave the cursor on the anchor. */
  erase(anchor: CursorPosition): string {
    this.painted = [];
    return ansi.cursorTo(anchor.row, anchor.col) + ansi.resetStyle + ansi.eraseDown + ansi.showCursor;
  }

  /** Forget what is on screen so the next frame is painted in full. */
  invalidate(): void {
    this.painted = [];
  }
}

/**
 * One row as styled text with its trailing blanks dropped, so a terminal that
 * reflows it on resize has nothing extra to wrap. The first `skipCells` cells
 * are left out (they belong to whatever sits left of the anchor).
 */
export const encodeRow = (spans: ReadonlyArray<PaintSpan>, colorDepth: ColorDepth, skipCells = 0): string => {
  const visible = trimTrailingBlanks(skipCells > 0 ? skipLeadingCells(spans, skipCells) : [...spans]);
  let output = '';
  let lastSgr = '';
  for (const span of visible) {
    const sgr = styleToSgr(span.style, colorDepth);
    // The last stop before the terminal: a control character in cell text would act, not show.
    const text = hasCellControls(span.text) ? stripCellControls(span.text) : span.text;
    // Neighbouring spans that encode alike (common at reduced colour depths) share one sequence.
    output += (sgr === lastSgr ? '' : sgr) + text;
    lastSgr = sgr;
  }
  return output;
};

/** Drop the first `cells` cells of a row. */
const skipLeadingCells = (spans: ReadonlyArray<PaintSpan>, cells: number): PaintSpan[] => {
  const result: PaintSpan[] = [];
  let position = 0;

  for (const span of spans) {
    const spanEnd = position + span.width;
    if (spanEnd <= cells) {
      position = spanEnd;
      continue;
    }

    if (position < cells) {
      const dropCells = cells - position;
      const characters = Array.from(span.text);
      // Narrow text can be cut by character. A wide glyph straddling the cut becomes padding.
      const text = characters.length === span.width
        ? characters.slice(dropCells).join('')
        : ' '.repeat(span.width - dropCells);
      result.push({ ...span, text, width: span.width - dropCells });
    } else {
      result.push(span);
    }
    position = spanEnd;
  }

  return result;
};

/** Trailing blank cells are cleared with an erase instead of being written out. */
const trimTrailingBlanks = (spans: PaintSpan[]): PaintSpan[] => {
  const result = [...spans];

  while (result.length > 0) {
    const last = result[result.length - 1]!;
    if (!isBlankStyle(last.style)) {
      break;
    }
    const trimmed = last.text.replace(/ +$/, '');
    if (trimmed.length > 0) {
      result[result.length - 1] = { ...last, text: trimmed, width: last.width - (last.text.length - trimmed.length) };
      break;
    }
    result.pop();
  }

  return result;
};
