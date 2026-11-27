/**
 * Characters kept from the start and from the end of one command's output.
 * An agent sees a few thousand characters per command at most, and can page
 * through the rest; past this, the middle is dropped.
 */
export const CAPTURE_HEAD_CHARS = 64 * 1024;
export const CAPTURE_TAIL_CHARS = 64 * 1024;

export interface OutputSnapshot {
  readonly head: string;
  /** Output after the omitted middle; empty when nothing was dropped. */
  readonly tail: string;
  readonly omittedChars: number;
  /** The command switched to the alternate screen (vim, less, htop…), whose contents are not kept. */
  readonly usedFullScreen: boolean;
}

// DEC private modes that switch to and from the alternate screen.
const ALT_SCREEN = /\u001b\[\?(?:1049|1047|47)([hl])/g;
const ALT_SCREEN_PREFIXES = ['\u001b[?1049', '\u001b[?1047', '\u001b[?47'].flatMap((sequence) =>
  Array.from({ length: sequence.length }, (_, index) => sequence.slice(0, index + 1)));

/**
 * One command's raw output, exactly as the program wrote it, minus anything
 * drawn on the alternate screen. Keeps the beginning and the end once it
 * grows past the cap; errors and summaries tend to be at the end.
 */
export class CapturedOutput {
  // Characters are copied into fixed buffers rather than keeping the strings
  // the program wrote: capturing a flood of output allocates nothing, so the
  // JavaScript heap does not grow with it.
  private readonly head = new Uint16Array(CAPTURE_HEAD_CHARS);
  private headLength = 0;
  /** A ring: `tailNext` is where the next character goes, overwriting the oldest. */
  private readonly tail = new Uint16Array(CAPTURE_TAIL_CHARS);
  private tailNext = 0;
  private tailLength = 0;
  private omitted = 0;
  private fullScreen = false;
  private usedFullScreen = false;
  /** A possibly incomplete alt-screen sequence at the end of the last chunk. */
  private carry = '';

  append(data: string): void {
    const input = this.carry + data;
    this.carry = '';

    let cursor = 0;
    for (const match of input.matchAll(ALT_SCREEN)) {
      if (!this.fullScreen) {
        this.store(input, cursor, match.index);
      }
      this.fullScreen = match[1] === 'h';
      this.usedFullScreen ||= this.fullScreen;
      cursor = match.index + match[0].length;
    }

    const end = input.length - trailingPrefixLength(input, cursor);
    this.carry = input.slice(end);
    if (!this.fullScreen) {
      this.store(input, cursor, end);
    }
  }

  /** The command has ended: keep any held-back text that turned out to be ordinary output. */
  finish(): void {
    if (!this.fullScreen) {
      this.store(this.carry, 0, this.carry.length);
    }
    this.carry = '';
  }

  snapshot(): OutputSnapshot {
    const tail = this.orderedTail();
    if (this.omitted === 0) {
      // Nothing was dropped: one piece, so no character is split at the seam.
      const whole = new Uint16Array(this.headLength + tail.length);
      whole.set(this.head.subarray(0, this.headLength));
      whole.set(tail, this.headLength);
      return { head: decode(whole), tail: '', omittedChars: 0, usedFullScreen: this.usedFullScreen };
    }
    return {
      head: decode(this.head.subarray(0, this.headLength)),
      tail: decode(tail),
      omittedChars: this.omitted,
      usedFullScreen: this.usedFullScreen,
    };
  }

  /** The ring's contents, oldest first. */
  private orderedTail(): Uint16Array {
    if (this.tailLength < CAPTURE_TAIL_CHARS) {
      return this.tail.subarray(0, this.tailLength);
    }
    const ordered = new Uint16Array(CAPTURE_TAIL_CHARS);
    ordered.set(this.tail.subarray(this.tailNext));
    ordered.set(this.tail.subarray(0, this.tailNext), CAPTURE_TAIL_CHARS - this.tailNext);
    return ordered;
  }

  private store(text: string, start: number, end: number): void {
    let index = start;
    while (index < end && this.headLength < CAPTURE_HEAD_CHARS) {
      this.head[this.headLength++] = text.charCodeAt(index++);
    }

    // Only the last CAPTURE_TAIL_CHARS of a long write can survive in the ring.
    const skip = Math.max(0, end - index - CAPTURE_TAIL_CHARS);
    if (skip > 0) {
      this.omitted += skip + this.tailLength;
      this.tailLength = 0;
      this.tailNext = 0;
      index += skip;
    }

    for (; index < end; index++) {
      this.tail[this.tailNext] = text.charCodeAt(index);
      this.tailNext = (this.tailNext + 1) % CAPTURE_TAIL_CHARS;
      if (this.tailLength < CAPTURE_TAIL_CHARS) {
        this.tailLength++;
      } else {
        this.omitted++;
      }
    }
  }
}

const utf16 = new TextDecoder('utf-16le');
const decode = (units: Uint16Array): string => (units.length === 0 ? '' : utf16.decode(units));

/** Length of a possibly unfinished alt-screen switch at the end of `text`, from `from` on. */
const trailingPrefixLength = (text: string, from: number): number => {
  const escape = text.lastIndexOf('\u001b');
  if (escape < from || text.length - escape > 7) {
    return 0;
  }
  return ALT_SCREEN_PREFIXES.includes(text.slice(escape)) ? text.length - escape : 0;
};
