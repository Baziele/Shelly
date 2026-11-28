import type { ColorDepth } from '../render/sgr.js';
import type { Tone } from '../ui/theme.js';
import { oneLine, sanitizeText, seg, type Line } from '../ui/agent/lines.js';
import { lineToPaintRow } from '../ui/agent/paint-line.js';
import { rowsToText } from '../ui/agent/static-render.js';

/*
 * Lines Shelly prints into the shell's scrollback (the echoed request, short
 * messages), styled through the theme at the terminal's colour depth, so
 * NO_COLOR and 16-colour terminals get what they can show. Each ends with
 * CRLF; long lines wrap as any output does.
 */

/** The request as the user typed it, after the prompt: `:: why did the build fail?`. */
export const echoText = (trigger: string, text: string, mode: 'agent' | 'fast', depth: ColorDepth, note?: string): string =>
  linesText([[
    seg(trigger, mode === 'fast' ? 'fast' : 'accent', { bold: true }),
    seg(' '),
    seg(oneLine(text)),
    ...(note ? [seg(` · ${oneLine(note)}`, 'muted')] : []),
  ]], depth);

/** Plain text, one terminal line per line of `text`. */
export const plainText = (text: string, depth: ColorDepth, tone?: Tone): string =>
  linesText(sanitizeText(text).split('\n').map((line): Line => [seg(line, tone)]), depth);

export const errorText = (text: string, depth: ColorDepth): string =>
  linesText([[seg('✗ ', 'error'), seg(oneLine(text), 'error')]], depth);

export const linesText = (lines: readonly Line[], depth: ColorDepth): string =>
  rowsToText(lines.map(lineToPaintRow), depth);
