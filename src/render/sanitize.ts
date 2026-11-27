/*
 * Text that came from outside Shelly (an agent's answer, file contents or
 * web pages it quotes, tool output, titles, thread names) must never reach
 * the terminal as control sequences: a clipboard write (OSC 52), a window
 * title, a hyperlink with a fake label (OSC 8), cursor moves, a screen clear.
 * Bidi overrides, isolates and marks (LRM, RLM, ALM) go too, so a title
 * cannot be made to read as something else. Printable text, markdown syntax included, is kept.
 */

/*
 * A string payload stops at any ESC or C1 byte (and an OSC at BEL), and at
 * 4096 characters: each attempt then scans only up to the next introducer,
 * so hostile text full of unterminated introducers stays linear.
 */
const PAYLOAD = '[^\\u001b\\u0080-\\u009f]{0,4096}';
const OSC_PAYLOAD = '[^\\u0007\\u001b\\u0080-\\u009f]{0,4096}';

// Whole sequences, so their payload does not stay behind as visible junk.
const ESCAPE_SEQUENCE = new RegExp([
  // CSI, 7-bit and 8-bit.
  '\\u001b\\[[0-?]*[ -/]*[@-~]',
  '\\u009b[0-?]*[ -/]*[@-~]',
  // OSC, ended by BEL or ST.
  `(?:\\u001b\\]|\\u009d)${OSC_PAYLOAD}(?:\\u0007|\\u001b\\\\|\\u009c)`,
  // DCS, SOS, PM and APC strings, ended by ST.
  `(?:\\u001b[PX^_]|[\\u0090\\u0098\\u009e\\u009f])${PAYLOAD}(?:\\u001b\\\\|\\u009c)`,
  // Any other escape: ESC, intermediates, a final byte. An unterminated string loses its introducer here.
  '\\u001b[ -/]*[0-~]?',
].join('|'), 'g');

/** C0 controls except tab and newline, DEL, C1 controls, and bidi embeddings, overrides and isolates. */
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069\u200e\u200f\u061c]/g;
const CONTROL_OR_LAYOUT = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069\u200e\u200f\u061c]/g;

export interface SanitizeOptions {
  /** Keep line breaks (`\n`; `\r\n` becomes `\n`). Default true; otherwise they become spaces. */
  readonly newlines?: boolean;
  /** Keep tabs. Default true; otherwise they become spaces. */
  readonly tabs?: boolean;
}

/** `text` without its escape sequences; control characters stay (see `sanitizeTerminalText`). */
export const stripEscapeSequences = (text: string): string =>
  (/[\u001b\u0090-\u009f]/.test(text) ? text.replace(ESCAPE_SEQUENCE, '') : text);

/** `text` without escape sequences or control characters: safe to hand to the terminal or to OpenTUI. */
export const sanitizeTerminalText = (text: string, { newlines = true, tabs = true }: SanitizeOptions = {}): string => {
  // Fast path: nothing to remove.
  if (!/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069\u200e\u200f\u061c]/.test(text)) {
    return newlines && tabs ? text : text.replace(newlines ? /\t/g : tabs ? /\n/g : /[\t\n]/g, ' ');
  }
  let clean = stripEscapeSequences(text).replace(/\r\n/g, '\n').replace(CONTROL, '');
  if (!newlines) {
    clean = clean.replace(/\n/g, ' ');
  }
  if (!tabs) {
    clean = clean.replace(/\t/g, ' ');
  }
  return clean;
};

/** Text already laid out for one cell row: every control character goes, tabs and newlines included. */
export const stripCellControls = (text: string): string => text.replace(CONTROL_OR_LAYOUT, '');

/** Whether `text` holds anything `stripCellControls` would remove. */
export const hasCellControls = (text: string): boolean => /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069\u200e\u200f\u061c]/.test(text);
