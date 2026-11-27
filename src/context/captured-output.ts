/** Characters kept from the start and from the end of one command's output. */
export const CAPTURE_HEAD_CHARS = 128 * 1024;
export const CAPTURE_TAIL_CHARS = 128 * 1024;

export interface OutputSnapshot {
  readonly head: string;
  /** Output after the omitted middle; empty unless something was dropped. */
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
  private head = '';
  private tail = '';
  private omitted = 0;
  private fullScreen = false;
  private usedFullScreen = false;
  /** A possibly incomplete alt-screen sequence at the end of the last chunk. */
  private carry = '';

  get size(): number {
    return this.head.length + this.tail.length + this.carry.length;
  }

  append(data: string): void {
    const input = this.carry + data;
    this.carry = '';

    let visible = '';
    let cursor = 0;
    for (const match of input.matchAll(ALT_SCREEN)) {
      if (!this.fullScreen) {
        visible += input.slice(cursor, match.index);
      }
      this.fullScreen = match[1] === 'h';
      this.usedFullScreen ||= this.fullScreen;
      cursor = match.index + match[0].length;
    }

    let rest = input.slice(cursor);
    const partial = trailingPrefixLength(rest);
    this.carry = rest.slice(rest.length - partial);
    rest = rest.slice(0, rest.length - partial);
    if (!this.fullScreen) {
      visible += rest;
    }
    this.store(visible);
  }

  /** The command has ended: keep any held-back text that turned out to be ordinary output. */
  finish(): void {
    if (!this.fullScreen) {
      this.store(this.carry);
    }
    this.carry = '';
  }

  snapshot(): OutputSnapshot {
    const overflow = Math.max(0, this.tail.length - CAPTURE_TAIL_CHARS);
    return {
      head: this.head,
      tail: this.tail.slice(overflow),
      omittedChars: this.omitted + overflow,
      usedFullScreen: this.usedFullScreen,
    };
  }

  private store(text: string): void {
    if (!text) {
      return;
    }

    const room = CAPTURE_HEAD_CHARS - this.head.length;
    if (room > 0) {
      this.head += text.slice(0, room);
      text = text.slice(room);
    }

    this.tail += text;
    // Trim lazily so a stream of small writes does not copy the tail each time.
    if (this.tail.length > CAPTURE_TAIL_CHARS * 2) {
      const drop = this.tail.length - CAPTURE_TAIL_CHARS;
      this.omitted += drop;
      this.tail = this.tail.slice(drop);
    }
  }
}

const trailingPrefixLength = (text: string): number => {
  const escape = text.lastIndexOf('\u001b');
  if (escape === -1 || text.length - escape > 7) {
    return 0;
  }
  return ALT_SCREEN_PREFIXES.includes(text.slice(escape)) ? text.length - escape : 0;
};
