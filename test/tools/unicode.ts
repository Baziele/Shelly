import type { IUnicodeVersionProvider, Terminal } from '@xterm/headless';

/*
 * @xterm/headless only ships Unicode 6 character widths, where emoji take one
 * cell. Real terminals give them two, so the emulator would disagree with the
 * screen the user sees. This provider uses modern widths: East Asian wide and
 * fullwidth characters and emoji presentation characters take two cells,
 * combining marks and format characters none. (Same idea as
 * @xterm/addon-unicode11, without the dependency.)
 */

const WIDE: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f], [0x2329, 0x232a], [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf],
  [0x4e00, 0x9fff], [0xa000, 0xa4cf], [0xa960, 0xa97f], [0xac00, 0xd7a3], [0xf900, 0xfaff],
  [0xfe10, 0xfe19], [0xfe30, 0xfe6f], [0xff00, 0xff60], [0xffe0, 0xffe6], [0x1f200, 0x1f2ff],
  [0x20000, 0x2fffd], [0x30000, 0x3fffd],
];
const ZERO = /^[\p{Mn}\p{Me}\p{Cf}]$/u;
const EMOJI = /^\p{Emoji_Presentation}$/u;

const cache = new Map<number, 0 | 1 | 2>();

export const charWidth = (codepoint: number): 0 | 1 | 2 => {
  if (codepoint < 0x7f) {
    return codepoint >= 0x20 ? 1 : 0;
  }
  let width = cache.get(codepoint);
  if (width === undefined) {
    const char = String.fromCodePoint(codepoint);
    width = codepoint <= 0x9f || ZERO.test(char) || (codepoint >= 0x1160 && codepoint <= 0x11ff)
      ? 0
      : EMOJI.test(char) || WIDE.some(([from, to]) => codepoint >= from && codepoint <= to)
        ? 2
        : 1;
    cache.set(codepoint, width);
  }
  return width;
};

/** Packs properties the way xterm's UnicodeService expects: kind << 3 | width << 1 | joins. */
const properties = (width: number, joins: boolean): number => ((width & 3) << 1) | (joins ? 1 : 0);

export const modernUnicode: IUnicodeVersionProvider = {
  version: 'shelly-modern',
  wcwidth: charWidth,
  charProperties(codepoint, preceding) {
    let width: number = charWidth(codepoint);
    // A zero-width character joins the cell before it, as xterm's own provider does.
    let joins = width === 0 && preceding !== 0;
    if (joins) {
      const before = (preceding >> 1) & 3;
      if (before === 0) {
        joins = false;
      } else if (before > width) {
        width = before;
      }
    }
    return properties(width, joins);
  },
};

/** Switch a terminal to modern character widths. Needs `allowProposedApi`. */
export const useModernWidths = (terminal: Terminal): void => {
  if (!terminal.unicode.versions.includes(modernUnicode.version)) {
    terminal.unicode.register(modernUnicode);
  }
  terminal.unicode.activeVersion = modernUnicode.version;
};
