import type { PaintSpan } from '../../render/inline-painter.js';
import type { PaintRow } from '../../render/live-region.js';
import { DEFAULT_COLOR, type CellColor } from '../../render/sgr.js';
import { displayWidth } from '../../render/text-width.js';
import type { Tone } from '../theme.js';
import type { Line } from './lines.js';

// Palette indexes behind the theme's tones (see theme.ts).
const TONE_INDEX: Record<Tone, number | undefined> = {
  text: undefined,
  accent: 5,
  fast: 6,
  muted: 8,
  success: 2,
  error: 1,
  warning: 3,
};

const toneColor = (tone: Tone | undefined): CellColor => {
  const index = TONE_INDEX[tone ?? 'text'];
  return index === undefined ? DEFAULT_COLOR : { kind: 'indexed', index };
};

/** A line straight to paint spans, for rows that need no layout. */
export const lineToPaintRow = (line: Line): PaintRow => line.map((segment): PaintSpan => ({
  text: segment.text,
  width: displayWidth(segment.text),
  style: {
    fg: toneColor(segment.tone),
    bg: DEFAULT_COLOR,
    attributes: (segment.bold ? 1 : 0) | (segment.italic ? 4 : 0) | (segment.strike ? 128 : 0),
  },
}));
