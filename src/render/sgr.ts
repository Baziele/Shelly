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

export type ColorDepth = 'truecolor' | 'ansi256';

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

/**
 * Terminals that advertise 24-bit colour set COLORTERM. Everything else gets
 * the 256-colour palette, which every terminal Shelly targets supports.
 */
export const detectColorDepth = (env: NodeJS.ProcessEnv = process.env): ColorDepth => {
  const colorTerm = env.COLORTERM?.toLowerCase();
  return colorTerm === 'truecolor' || colorTerm === '24bit' ? 'truecolor' : 'ansi256';
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

const colorParameters = (color: CellColor, layer: 'fg' | 'bg', depth: ColorDepth): string[] => {
  const isForeground = layer === 'fg';

  switch (color.kind) {
    case 'default':
      return [];
    case 'indexed':
      if (color.index < 8) {
        return [String((isForeground ? 30 : 40) + color.index)];
      }
      if (color.index < 16) {
        return [String((isForeground ? 90 : 100) + color.index - 8)];
      }
      return [isForeground ? '38' : '48', '5', String(color.index)];
    case 'rgb':
      if (depth === 'truecolor') {
        return [isForeground ? '38' : '48', '2', String(color.r), String(color.g), String(color.b)];
      }
      return [isForeground ? '38' : '48', '5', String(rgbToAnsi256(color.r, color.g, color.b))];
  }
};

/** A self-contained SGR sequence: it resets first, so it never inherits earlier styling. */
export const styleToSgr = (style: CellStyle, depth: ColorDepth): string => {
  const parameters = ['0'];

  for (const [bit, parameter] of ATTRIBUTE_PARAMETERS) {
    if (style.attributes & bit) {
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
