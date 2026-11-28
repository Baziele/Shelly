/**
 * Shelly's shell hooks (see shell-integration/) report what the shell is doing
 * by printing private escape sequences into its output:
 *
 *   ESC ] 6973 ; <nonce> ; <kind> ; <payload> BEL
 *
 *   exec;<command>  a command line is about to run (empty: run, but unnamed)
 *   done;<status>   the shell is back at a prompt; the last command exited
 *   cwd;<path>      the shell's working directory; sent at every prompt
 *   line-editor;<features>  what the hooks can do with the input line, as a
 *                   comma-separated list: capture, set (read and replace it),
 *                   notice (show a message below it), query (read it,
 *                   leaving it alone), and for bash 3.2, which can do none
 *                   of those, clear and jump (move the cursor to the line's
 *                   end and back)
 *   line;<request>;<buffer>;<cursor>  the input line and its cursor (in
 *                   characters), which the shell has just cleared; a cursor
 *                   of -1 means the line could not be reported and was left
 *                   alone
 *   line-set;<request>  the shell has replaced its input line
 *   query;<request>;<buffer>;<cursor>  the input line and its cursor, as for
 *                   `line`, but left as they are
 *
 * <request> is the number Shelly gave the request in the line file, or empty
 * when the shell found none there (Shelly had given up on it).
 *
 * The line markers answer keys Shelly sends; see line-editor.ts.
 *
 * Payloads are percent-encoded. The nonce is chosen per session and taken
 * out of the environment before the user's startup files run, so programs
 * the user runs (`cat` of a crafted file, say) cannot forge events. Shelly
 * strips its own markers; everything else, including sequences that merely
 * look like them, reaches the terminal unchanged.
 */

export const MARKER_OSC = 6973;

export type ShellEvent =
  | { readonly type: 'exec'; readonly command: string }
  | { readonly type: 'done'; readonly exitCode: number | undefined }
  | { readonly type: 'cwd'; readonly path: string }
  | { readonly type: 'line-editor'; readonly features: readonly string[] }
  /**
   * `request` names the request this answers, if the shell found one; `line`
   * is absent when the shell could not report it (it was too long, say).
   */
  | { readonly type: 'line'; readonly request: number | undefined; readonly line: ShellInputLine | undefined }
  /** As `line`, for a query: the shell left its line as it was. */
  | { readonly type: 'line-query'; readonly request: number | undefined; readonly line: ShellInputLine | undefined }
  | { readonly type: 'line-set'; readonly request: number | undefined };

/** The shell's input line as the hooks report it. */
export interface ShellInputLine {
  readonly buffer: string;
  /** In characters (code points), as the shell counts them. */
  readonly cursor: number;
}

export type ShellOutputSegment =
  | { readonly type: 'output'; readonly data: string }
  | { readonly type: 'event'; readonly event: ShellEvent };

const PREFIX = `\u001b]${MARKER_OSC};`;
const BEL = '\u0007';
const ESC = '\u001b';
/** Command lines can be long, but a marker that never ends is not one of ours. */
const MAX_MARKER_LENGTH = 64 * 1024;

/** Splits shell output into passthrough text and Shelly's events, across chunk boundaries. */
export class ShellMarkerParser {
  /** Text held back because it may be the start of a marker. */
  private pending = '';
  /** Inside one of our markers that grew too long; dropped up to its end. */
  private discarding = false;
  private readonly ownPrefix: string;

  constructor(private readonly nonce: string) {
    this.ownPrefix = `${nonce};`;
  }

  /**
   * True when only a few bytes that might begin a marker are held back. A
   * caller can `flush()` these after a moment so a lone ESC is not delayed.
   * A marker that has fully started is never flushed: forwarding half of one
   * would leave the terminal inside an unterminated escape sequence.
   */
  get isHoldingPartialPrefix(): boolean {
    return this.pending.length > 0 && this.pending.length < PREFIX.length;
  }

  push(data: string): ShellOutputSegment[] {
    let input = this.pending + data;
    this.pending = '';
    if (this.discarding) {
      const end = input.search(/[\u0007\u001b]/);
      if (end === -1) {
        return [];
      }
      this.discarding = false;
      // BEL or ST ends the marker; any other ESC starts ordinary output again.
      const skip = input[end] === BEL ? 1 : input[end + 1] === '\\' ? 2 : 0;
      input = input.slice(end + skip);
    }
    const segments: ShellOutputSegment[] = [];
    const output = (text: string): void => {
      if (text) {
        segments.push({ type: 'output', data: text });
      }
    };

    let cursor = 0;
    while (cursor < input.length) {
      const start = input.indexOf(PREFIX, cursor);
      if (start === -1) {
        const held = partialPrefixLength(input, cursor);
        output(input.slice(cursor, input.length - held));
        this.pending = input.slice(input.length - held);
        break;
      }

      output(input.slice(cursor, start));
      const bodyStart = start + PREFIX.length;
      const end = findTerminator(input, bodyStart);

      if (end !== 'incomplete' && end !== 'malformed') {
        const parsed = this.parseBody(input.slice(bodyStart, end.index));
        if (parsed === 'foreign') {
          output(input.slice(start, end.index + end.length));
        } else if (parsed !== 'ignored') {
          segments.push({ type: 'event', event: parsed });
        }
        cursor = end.index + end.length;
        continue;
      }

      // Unfinished or broken. Someone else's lookalike goes to the terminal
      // as soon as it is clearly not ours, rather than holding output back.
      if (!this.couldBeOurs(input, bodyStart)) {
        output(PREFIX);
        cursor = bodyStart;
        continue;
      }
      if (end === 'malformed') {
        // Ours, but cut short: drop it, never show the nonce.
        cursor = input.indexOf(ESC, bodyStart);
        continue;
      }
      if (input.length - start > MAX_MARKER_LENGTH) {
        this.discarding = true;
        break;
      }
      this.pending = input.slice(start);
      break;
    }

    return mergeOutput(segments);
  }

  /** Release held-back text as output. */
  flush(): ShellOutputSegment[] {
    const held = this.pending;
    this.pending = '';
    return held ? [{ type: 'output', data: held }] : [];
  }

  /** The text from `from` on is, or may still become, `<nonce>;…`. */
  private couldBeOurs(input: string, from: number): boolean {
    const seen = input.slice(from, from + this.ownPrefix.length);
    return this.ownPrefix.startsWith(seen);
  }

  private parseBody(body: string): ShellEvent | 'foreign' | 'ignored' {
    const [nonce, kind, ...rest] = body.split(';');
    if (nonce !== this.nonce || kind === undefined) {
      return 'foreign';
    }

    const raw = rest.join(';');
    if (kind === 'line' || kind === 'query') {
      const type = kind === 'line' ? 'line' : 'line-query';
      const split = raw.indexOf(';');
      return split === -1
        ? { type, request: undefined, line: undefined }
        : { type, request: parseRequest(raw.slice(0, split)), line: parseLine(raw.slice(split + 1)) };
    }
    const payload = decodePayload(raw);
    switch (kind) {
      case 'exec':
        return { type: 'exec', command: payload };
      case 'done': {
        const exitCode = Number.parseInt(payload, 10);
        return { type: 'done', exitCode: Number.isNaN(exitCode) ? undefined : exitCode };
      }
      case 'cwd':
        return { type: 'cwd', path: payload };
      case 'line-editor':
        return { type: 'line-editor', features: payload.split(',').filter(Boolean) };
      case 'line-set':
        return { type: 'line-set', request: parseRequest(payload) };
      default:
        // From a newer hook script; nothing to do with it.
        return 'ignored';
    }
  }
}

const parseRequest = (text: string): number | undefined => (/^\d+$/.test(text) ? Number(text) : undefined);

/** `<buffer>;<cursor>`: the buffer may hold `;` itself, the cursor never does. */
const parseLine = (raw: string): ShellInputLine | undefined => {
  const split = raw.lastIndexOf(';');
  const cursor = raw.slice(split + 1);
  if (split === -1 || !/^\d+$/.test(cursor)) {
    return undefined;
  }
  return { buffer: decodePayload(raw.slice(0, split)), cursor: Number(cursor) };
};

/** How many characters at the end of `input` could be the beginning of a marker. */
const partialPrefixLength = (input: string, from: number): number => {
  const longest = Math.min(PREFIX.length - 1, input.length - from);
  for (let length = longest; length > 0; length--) {
    if (input.endsWith(PREFIX.slice(0, length))) {
      return length;
    }
  }
  return 0;
};

type Terminator = { readonly index: number; readonly length: number } | 'incomplete' | 'malformed';

/** A marker ends at BEL or ST (ESC \). Payloads never contain a raw ESC. */
const findTerminator = (input: string, from: number): Terminator => {
  for (let index = from; index < input.length; index++) {
    const char = input[index];
    if (char === BEL) {
      return { index, length: 1 };
    }
    if (char === ESC) {
      if (index + 1 >= input.length) {
        return 'incomplete';
      }
      return input[index + 1] === '\\' ? { index, length: 2 } : 'malformed';
    }
  }
  return 'incomplete';
};

/** Undo the hooks' percent-encoding. fish encodes every non-ASCII byte; zsh and bash only the unsafe few. */
export const decodePayload = (payload: string): string => {
  if (!payload.includes('%')) {
    return payload;
  }
  try {
    return decodeURIComponent(payload);
  } catch {
    // Not valid UTF-8 once decoded; keep each escape as the raw byte value.
    return payload.replace(/%([0-9A-Fa-f]{2})/g, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
  }
};

const mergeOutput = (segments: ShellOutputSegment[]): ShellOutputSegment[] => {
  const merged: ShellOutputSegment[] = [];
  for (const segment of segments) {
    const previous = merged.at(-1);
    if (segment.type === 'output' && previous?.type === 'output') {
      merged[merged.length - 1] = { type: 'output', data: previous.data + segment.data };
    } else {
      merged.push(segment);
    }
  }
  return merged;
};
