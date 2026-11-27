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

/** Control characters and escape sequences removed, tabs expanded, carriage-return overwrites resolved. */
export const sanitizeText = (text: string): string => text
  .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
  .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, '')
  .replace(/\u001b[@-_]/g, '')
  .replace(/\r\n/g, '\n')
  .split('\n')
  // A progress bar redraws its line with `\r`; only the last state matters.
  .map((line) => (line.includes('\r') ? line.slice(line.lastIndexOf('\r') + 1) : line))
  .join('\n')
  .replace(/\t/g, '  ')
  .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, '');

/** A single line: whitespace (newlines included) collapsed. */
export const oneLine = (text: string): string => sanitizeText(text).replace(/\s+/g, ' ').trim();
