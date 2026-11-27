import { RGBA } from '@opentui/core';

/**
 * Shelly draws with the terminal's own palette (indexed and default colours)
 * so it matches whatever theme the user already has.
 */
export const theme = {
  text: RGBA.defaultForeground(),
  /** Agent mode (`::`). */
  accent: RGBA.fromIndex(5),
  /** Fast mode (`__`). */
  fast: RGBA.fromIndex(6),
  muted: RGBA.fromIndex(8),
  success: RGBA.fromIndex(2),
  error: RGBA.fromIndex(1),
  warning: RGBA.fromIndex(3),
  link: RGBA.fromIndex(4),
  code: RGBA.fromIndex(6),
  transparent: RGBA.fromInts(0, 0, 0, 0),
} as const;

export type Tone = 'text' | 'accent' | 'fast' | 'muted' | 'success' | 'error' | 'warning';
