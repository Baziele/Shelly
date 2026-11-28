import { sanitizeTerminalText, stripEscapeSequences } from '../../render/sanitize.js';
import { displayWidth, truncateEnd } from '../../render/text-width.js';
import type { Tone } from '../theme.js';

/**
 * Styled text as plain data: what the agent view's formatters produce. Kept
 * free of OpenTUI so formatting can be tested on its own; `styled.ts` turns
 * it into OpenTUI text.
 */
export interface Segment {
  readonly text: string;
  readonly tone?: Tone;
  readonly bold?: boolean;
  readonly italic?: boolean;
  readonly strike?: boolean;
}

export type Line = readonly Segment[];

export const seg = (text: string, tone?: Tone, style: Omit<Segment, 'text' | 'tone'> = {}): Segment =>
  ({ text, ...(tone ? { tone } : {}), ...style });

export const lineText = (line: Line): string => line.map((segment) => segment.text).join('');

export const lineWidth = (line: Line): number => displayWidth(lineText(line));

/** `line` cut to `width` cells, the cut marked with `…`. */
export const fitLine = (line: Line, width: number): Line => {
  if (lineWidth(line) <= width) {
    return line;
  }
  const result: Segment[] = [];
  let used = 0;
  for (const segment of line) {
    const cells = displayWidth(segment.text);
    if (used + cells < width) {
      result.push(segment);
      used += cells;
      continue;
    }
    result.push({ ...segment, text: truncateEnd(segment.text + ' ', width - used) });
    break;
  }
  return result;
};

/**
 * `left` with `right` aligned to the right edge when both fit with a gap of
 * at least two cells; otherwise `left` alone, cut to fit.
 */
export const alignRight = (left: Line, right: Line, width: number): Line => {
  const gap = width - lineWidth(left) - lineWidth(right);
  if (right.length === 0 || gap < 2) {
    return fitLine(left, width);
  }
  return [...left, seg(' '.repeat(gap)), ...right];
};

/**
 * Tool output made safe and plain: escape sequences and control characters
 * removed, carriage-return overwrites resolved (a progress bar keeps its last
 * state), tabs expanded.
 */
export const sanitizeText = (text: string): string => sanitizeTerminalText(
  stripEscapeSequences(text)
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => (line.includes('\r') ? line.slice(line.lastIndexOf('\r') + 1) : line))
    .join('\n'),
).replace(/\t/g, '  ');

/** A single line: whitespace (newlines included) collapsed. */
export const oneLine = (text: string): string => sanitizeText(text).replace(/\s+/g, ' ').trim();

const wordSegments = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/**
 * `text` broken into rows of at most `width` cells, between words where it
 * can; a word longer than a row is split.
 */
export const wrapText = (text: string, width: number): string[] => {
  const rows: string[] = [];
  let row = '';
  let rowWidth = 0;
  const push = (): void => {
    rows.push(row.trimEnd());
    row = '';
    rowWidth = 0;
  };
  for (const word of text.split(/(\s+)/)) {
    if (word === '') {
      continue;
    }
    const isSpace = /^\s+$/.test(word);
    const cells = displayWidth(isSpace ? ' ' : word);
    if (isSpace) {
      if (rowWidth > 0 && rowWidth + 1 <= width) {
        row += ' ';
        rowWidth += 1;
      }
      continue;
    }
    if (rowWidth + cells <= width) {
      row += word;
      rowWidth += cells;
      continue;
    }
    if (rowWidth > 0) {
      push();
    }
    if (cells <= width) {
      row = word;
      rowWidth = cells;
      continue;
    }
    // Longer than a row: split it.
    for (const { segment } of wordSegments.segment(word)) {
      const segmentCells = displayWidth(segment);
      if (rowWidth + segmentCells > width && rowWidth > 0) {
        push();
      }
      row += segment;
      rowWidth += segmentCells;
    }
  }
  if (row !== '' || rows.length === 0) {
    push();
  }
  return rows;
};

/**
 * A message as rows: `label` on the first row, the text wrapped after it and
 * indented to line up under it on the rows that follow. Messages wrap (their
 * end is often the useful part); only one-line hints are cut.
 */
export const wrapMessage = (label: readonly Segment[], text: string, style: Omit<Segment, 'text'>, width: number): Line[] => {
  const indent = lineWidth(label);
  const rows = wrapText(text, Math.max(8, width - indent));
  return rows.map((row, index) => [
    ...(index === 0 ? label : [seg(' '.repeat(indent))]),
    { ...style, text: row },
  ]);
};
