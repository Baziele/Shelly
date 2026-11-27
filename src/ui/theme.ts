import { RGBA } from '@opentui/core';

/**
 * Shelly draws with the terminal's own palette (indexed and default colours)
 * so it matches whatever theme the user already has.
 */
export const theme = {
  text: RGBA.defaultForeground(),
  accent: RGBA.fromIndex(5),
  muted: RGBA.fromIndex(8),
  transparent: RGBA.fromInts(0, 0, 0, 0),
} as const;
