/** Converts cell styles into SGR (Select Graphic Rendition) escape sequences. */

export type CellColor =
  | { readonly kind: 'default' }
  | { readonly kind: 'indexed'; readonly index: number }
  | { readonly kind: 'rgb'; readonly r: number; readonly g: number; readonly b: number };

export interface CellStyle {
  readonly fg: CellColor;
  readonly bg: CellColor;
  /** OpenTUI `TextAttributes` bit flags. */
  readonly attributes: number;
}

/**
 * How many colours the terminal can show. `ansi16` keeps to the 16 palette
 * entries the user's theme defines; `none` (NO_COLOR, dumb terminals) keeps
 * text attributes only and shows the muted grey as dim.
 */
export type ColorDepth = 'truecolor' | 'ansi256' | 'ansi16' | 'none';

export const DEFAULT_COLOR: CellColor = { kind: 'default' };

// OpenTUI attribute bit → SGR parameter.
const ATTRIBUTE_PARAMETERS: ReadonlyArray<readonly [bit: number, parameter: number]> = [
  [1, 1], // bold
  [2, 2], // dim
  [4, 3], // italic
  [8, 4], // underline
  [16, 5], // blink
  [32, 7], // inverse
  [64, 8], // hidden
  [128, 9], // strikethrough
];

/** Attributes whose effect is visible on a blank cell. */
const VISIBLE_ON_BLANK = 8 | 32 | 128;

/** The palette index Shelly uses for muted text; without colour it shows as dim instead. */
const MUTED_INDEX = 8;
const DIM_BIT = 2;

/**
 * NO_COLOR (https://no-color.org) and dumb terminals get no colour at all.
 * Terminals that advertise 24-bit colour set COLORTERM. The Linux console and
 * `*-16color` terminals get the 16 base colours. Everything else gets the
 * 256-colour palette, which every terminal Shelly targets supports.
 */
export const detectColorDepth = (env: NodeJS.ProcessEnv = process.env): ColorDepth => {
  const term = env.TERM?.toLowerCase() ?? '';
  if ((env.NO_COLOR !== undefined && env.NO_COLOR !== '') || term === 'dumb') {
    return 'none';
  }
  const colorTerm = env.COLORTERM?.toLowerCase();
  if (colorTerm === 'truecolor' || colorTerm === '24bit') {
    return 'truecolor';
  }
  if (term === 'linux' || term.endsWith('-16color') || term === 'vt100' || term === 'vt220') {
    return 'ansi16';
  }
  return 'ansi256';
};

/** The RGB value xterm shows for a 256-palette index of 16 or more. */
const ansi256ToRgb = (index: number): readonly [number, number, number] => {
  if (index >= 232) {
    const level = 8 + (index - 232) * 10;
    return [level, level, level];
  }
  const cube = index - 16;
  const level = (value: number): number => (value === 0 ? 0 : 55 + value * 40);
  return [level(Math.floor(cube / 36)), level(Math.floor(cube / 6) % 6), level(cube % 6)];
};

// Typical values of the 16 base colours, only to find the nearest one; the terminal shows its own.
const BASE_16: ReadonlyArray<readonly [number, number, number]> = [
  [0, 0, 0], [205, 0, 0], [0, 205, 0], [205, 205, 0], [0, 0, 238], [205, 0, 205], [0, 205, 205], [229, 229, 229],
  [127, 127, 127], [255, 0, 0], [0, 255, 0], [255, 255, 0], [92, 92, 255], [255, 0, 255], [0, 255, 255], [255, 255, 255],
];

/** Nearest of the 16 base palette entries for an RGB colour. */
export const rgbToAnsi16 = (r: number, g: number, b: number): number => {
  let best = 0;
  let bestDistance = Infinity;
  BASE_16.forEach(([br, bg, bb], index) => {
    const distance = (r - br) ** 2 + (g - bg) ** 2 + (b - bb) ** 2;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = index;
    }
  });
  return best;
};

/** Nearest xterm-256 palette index for an RGB colour. */
export const rgbToAnsi256 = (r: number, g: number, b: number): number => {
  if (r === g && g === b) {
    if (r < 8) {
      return 16;
    }
    if (r > 248) {
      return 231;
    }
    return Math.round(((r - 8) / 247) * 24) + 232;
  }

  const level = (value: number): number => Math.round((value / 255) * 5);
  return 16 + 36 * level(r) + 6 * level(g) + level(b);
};

const paletteParameters = (index: number, isForeground: boolean): string[] =>
  [String((isForeground ? 30 : 40) + (index % 8) + (index >= 8 ? 60 : 0))];

const colorParameters = (color: CellColor, layer: 'fg' | 'bg', depth: ColorDepth): string[] => {
  const isForeground = layer === 'fg';

  switch (color.kind) {
    case 'default':
      return [];
    case 'indexed':
      if (depth === 'none') {
        return [];
      }
      if (depth === 'ansi16' && color.index >= 16) {
        return paletteParameters(rgbToAnsi16(...ansi256ToRgb(color.index)), isForeground);
      }
      if (color.index < 8) {
        return [String((isForeground ? 30 : 40) + color.index)];
      }
      if (color.index < 16) {
        return [String((isForeground ? 90 : 100) + color.index - 8)];
      }
      return [isForeground ? '38' : '48', '5', String(color.index)];
    case 'rgb':
      if (depth === 'none') {
        return [];
      }
      if (depth === 'ansi16') {
        return paletteParameters(rgbToAnsi16(color.r, color.g, color.b), isForeground);
      }
      if (depth === 'truecolor') {
        return [isForeground ? '38' : '48', '2', String(color.r), String(color.g), String(color.b)];
      }
      return [isForeground ? '38' : '48', '5', String(rgbToAnsi256(color.r, color.g, color.b))];
  }
};

/** A self-contained SGR sequence: it resets first, so it never inherits earlier styling. */
export const styleToSgr = (style: CellStyle, depth: ColorDepth): string => {
  const parameters = ['0'];
  const mutedWithoutColor = depth === 'none' && style.fg.kind === 'indexed' && style.fg.index === MUTED_INDEX;
  const attributes = style.attributes | (mutedWithoutColor ? DIM_BIT : 0);

  for (const [bit, parameter] of ATTRIBUTE_PARAMETERS) {
    if (attributes & bit) {
      parameters.push(String(parameter));
    }
  }
  parameters.push(...colorParameters(style.fg, 'fg', depth));
  parameters.push(...colorParameters(style.bg, 'bg', depth));

  return `\u001b[${parameters.join(';')}m`;
};

/** True when a run of spaces in this style looks the same as an erased cell. */
export const isBlankStyle = (style: CellStyle): boolean =>
  style.bg.kind === 'default' && (style.attributes & VISIBLE_ON_BLANK) === 0;
