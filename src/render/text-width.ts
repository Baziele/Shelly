/**
 * How many terminal cells text takes, close to what terminals do: East Asian
 * wide and fullwidth characters and emoji take two cells, combining marks and
 * zero-width characters none. Text is measured by grapheme, so an emoji
 * sequence joined with ZWJ counts once.
 */

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

const ZERO_WIDTH = /^(?:\p{Mn}|\p{Me}|\p{Cf}|[\u200b-\u200f\u2028-\u202e\u2060-\u2064\ufe00-\ufe0f])+$/u;
const EMOJI_PRESENTATION = /\p{Emoji_Presentation}|\p{Extended_Pictographic}\ufe0f/u;

// Wide and fullwidth ranges (Unicode East Asian Width W and F), condensed.
const WIDE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f], [0x231a, 0x231b], [0x2329, 0x232a], [0x23e9, 0x23ec], [0x23f0, 0x23f0], [0x23f3, 0x23f3],
  [0x25fd, 0x25fe], [0x2614, 0x2615], [0x2648, 0x2653], [0x267f, 0x267f], [0x2693, 0x2693], [0x26a1, 0x26a1],
  [0x26aa, 0x26ab], [0x26bd, 0x26be], [0x26c4, 0x26c5], [0x26ce, 0x26ce], [0x26d4, 0x26d4], [0x26ea, 0x26ea],
  [0x26f2, 0x26f3], [0x26f5, 0x26f5], [0x26fa, 0x26fa], [0x26fd, 0x26fd], [0x2705, 0x2705], [0x270a, 0x270b],
  [0x2728, 0x2728], [0x274c, 0x274c], [0x274e, 0x274e], [0x2753, 0x2755], [0x2757, 0x2757], [0x2795, 0x2797],
  [0x27b0, 0x27b0], [0x27bf, 0x27bf], [0x2b1b, 0x2b1c], [0x2b50, 0x2b50], [0x2b55, 0x2b55], [0x2e80, 0x303e],
  [0x3041, 0x33ff], [0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xa000, 0xa4cf], [0xa960, 0xa97f], [0xac00, 0xd7a3],
  [0xf900, 0xfaff], [0xfe10, 0xfe19], [0xfe30, 0xfe6f], [0xff00, 0xff60], [0xffe0, 0xffe6], [0x16fe0, 0x16fe4],
  [0x17000, 0x18cff], [0x1b000, 0x1b2ff], [0x1f004, 0x1f004], [0x1f0cf, 0x1f0cf], [0x1f18e, 0x1f18e],
  [0x1f191, 0x1f19a], [0x1f200, 0x1f251], [0x1f300, 0x1f64f], [0x1f680, 0x1f6ff], [0x1f7e0, 0x1f7eb],
  [0x1f90c, 0x1f9ff], [0x1fa70, 0x1faff], [0x20000, 0x2fffd], [0x30000, 0x3fffd],
];

const isWideCodePoint = (codePoint: number): boolean => {
  let low = 0;
  let high = WIDE_RANGES.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const [start, end] = WIDE_RANGES[middle]!;
    if (codePoint < start) {
      high = middle - 1;
    } else if (codePoint > end) {
      low = middle + 1;
    } else {
      return true;
    }
  }
  return false;
};

/** Cells one grapheme takes: 0, 1 or 2. */
export const graphemeWidth = (grapheme: string): number => {
  const codePoint = grapheme.codePointAt(0) ?? 0;
  // Fast path for printable ASCII.
  if (grapheme.length === 1 && codePoint >= 0x20 && codePoint < 0x7f) {
    return 1;
  }
  if (codePoint < 0x20 || (codePoint >= 0x7f && codePoint < 0xa0) || ZERO_WIDTH.test(grapheme)) {
    return 0;
  }
  if (isWideCodePoint(codePoint) || EMOJI_PRESENTATION.test(grapheme)) {
    return 2;
  }
  return 1;
};

const isPlainAscii = (text: string): boolean => /^[\x20-\x7e]*$/.test(text);

export const displayWidth = (text: string): number => {
  if (isPlainAscii(text)) {
    return text.length;
  }
  let width = 0;
  for (const { segment } of segmenter.segment(text)) {
    width += graphemeWidth(segment);
  }
  return width;
};

/** The longest start of `text` that fits in `width` cells. */
const fitStart = (text: string, width: number): string => {
  if (isPlainAscii(text)) {
    return text.slice(0, width);
  }
  let used = 0;
  let result = '';
  for (const { segment } of segmenter.segment(text)) {
    const cells = graphemeWidth(segment);
    if (used + cells > width) {
      break;
    }
    used += cells;
    result += segment;
  }
  return result;
};

/** The longest end of `text` that fits in `width` cells. */
const fitEnd = (text: string, width: number): string => {
  if (isPlainAscii(text)) {
    return width <= 0 ? '' : text.slice(-width);
  }
  const graphemes = Array.from(segmenter.segment(text), ({ segment }) => segment);
  let used = 0;
  let start = graphemes.length;
  while (start > 0) {
    const cells = graphemeWidth(graphemes[start - 1]!);
    if (used + cells > width) {
      break;
    }
    used += cells;
    start--;
  }
  return graphemes.slice(start).join('');
};

/** `text` cut to `width` cells, ending in `…` when it was cut. */
export const truncateEnd = (text: string, width: number): string => {
  if (width <= 0) {
    return '';
  }
  if (displayWidth(text) <= width) {
    return text;
  }
  return fitStart(text, width - 1) + '…';
};

/** `text` cut to `width` cells from the left, starting with `…` when it was cut. */
export const truncateStart = (text: string, width: number): string => {
  if (width <= 0) {
    return '';
  }
  if (displayWidth(text) <= width) {
    return text;
  }
  return '…' + fitEnd(text, width - 1);
};

/** `text` padded with spaces to `width` cells (never cut). */
export const padEnd = (text: string, width: number): string =>
  text + ' '.repeat(Math.max(0, width - displayWidth(text)));
