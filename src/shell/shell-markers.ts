/**
 * Shelly's shell hooks (see shell-integration/) report what the shell is doing
 * by printing private escape sequences into its output:
 *
 *   ESC ] 6973 ; <nonce> ; <kind> ; <payload> BEL
 *
 *   exec;<command>  a command line is about to run (empty: run, but unnamed)
 *   done;<status>   the shell is back at a prompt; the last command exited
 *   cwd;<path>      the shell's working directory
 *
 * Payloads are percent-encoded. The nonce is chosen per session and never
 * exported, so output from programs (`cat` of a crafted file, say) cannot
 * forge events. Shelly strips its own markers; everything else, including
 * sequences that merely look like them, reaches the terminal unchanged.
 */

export const MARKER_OSC = 6973;

export type ShellEvent =
  | { readonly type: 'exec'; readonly command: string }
  | { readonly type: 'done'; readonly exitCode: number | undefined }
  | { readonly type: 'cwd'; readonly path: string };

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

  constructor(private readonly nonce: string) {}

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
    const input = this.pending + data;
    this.pending = '';
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

      if (end === 'incomplete') {
        if (input.length - start > MAX_MARKER_LENGTH) {
          output(PREFIX);
          cursor = bodyStart;
          continue;
        }
        this.pending = input.slice(start);
        break;
      }

      if (end === 'malformed') {
        output(PREFIX);
        cursor = bodyStart;
        continue;
      }

      const parsed = this.parseBody(input.slice(bodyStart, end.index));
      if (parsed === 'foreign') {
        output(input.slice(start, end.index + end.length));
      } else if (parsed !== 'ignored') {
        segments.push({ type: 'event', event: parsed });
      }
      cursor = end.index + end.length;
    }

    return mergeOutput(segments);
  }

  /** Release held-back text as output. */
  flush(): ShellOutputSegment[] {
    const held = this.pending;
    this.pending = '';
    return held ? [{ type: 'output', data: held }] : [];
  }

  private parseBody(body: string): ShellEvent | 'foreign' | 'ignored' {
    const [nonce, kind, ...rest] = body.split(';');
    if (nonce !== this.nonce || kind === undefined) {
      return 'foreign';
    }

    const payload = decodePayload(rest.join(';'));
    switch (kind) {
      case 'exec':
        return { type: 'exec', command: payload };
      case 'done': {
        const exitCode = Number.parseInt(payload, 10);
        return { type: 'done', exitCode: Number.isNaN(exitCode) ? undefined : exitCode };
      }
      case 'cwd':
        return { type: 'cwd', path: payload };
      default:
        // From a newer hook script; nothing to do with it.
        return 'ignored';
    }
  }
}

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
