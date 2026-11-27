/** Raw terminal input split into the few keys the agent view understands. */

export type Key =
  | { readonly name: 'escape' | 'ctrl-c' | 'enter' | 'tab' | 'shift-tab' | 'left' | 'right' | 'up' | 'down' | 'backspace' }
  | { readonly name: 'char'; readonly char: string }
  | { readonly name: 'other'; readonly sequence: string };

// An escape sequence (CSI or SS3), a lone escape, or one character.
const KEY_PATTERN = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001bO[A-Za-z]|\u001b[\s\S]?|[\s\S]/gu;

const SEQUENCES: Record<string, Key['name']> = {
  '\u001b[A': 'up',
  '\u001bOA': 'up',
  '\u001b[B': 'down',
  '\u001bOB': 'down',
  '\u001b[C': 'right',
  '\u001bOC': 'right',
  '\u001b[D': 'left',
  '\u001bOD': 'left',
  '\u001b[Z': 'shift-tab',
};

export const parseKeys = (data: string): Key[] => (data.match(KEY_PATTERN) ?? []).map((sequence): Key => {
  switch (sequence) {
    case '\u001b':
      return { name: 'escape' };
    case '\u0003':
      return { name: 'ctrl-c' };
    case '\r':
    case '\n':
      return { name: 'enter' };
    case '\t':
      return { name: 'tab' };
    case '\u007f':
    case '\b':
      return { name: 'backspace' };
  }
  const named = SEQUENCES[sequence];
  if (named) {
    return { name: named } as Key;
  }
  if (sequence.startsWith('\u001b') || /^[\u0000-\u001f]$/.test(sequence)) {
    return { name: 'other', sequence };
  }
  return { name: 'char', char: sequence };
});

const PASTE_START = '\u001b[200~';
const PASTE_END = '\u001b[201~';

/** A paste with no input for this long, or this long, is taken to have lost its end marker. */
const PASTE_IDLE_MS = 500;
const PASTE_MAX_CHARS = 1_000_000;

/**
 * Removes bracketed pastes (everything between ESC[200~ and ESC[201~) from
 * raw input, following a paste across reads. Pasted text is never a key.
 * A paste whose end marker never comes is given up after half a second with
 * no input, or a million characters, so later keys are keys again.
 */
export class PasteFilter {
  private inPaste = false;
  private lastInputAt = 0;
  private pastedChars = 0;

  constructor(private readonly now: () => number = Date.now) {}

  get isInPaste(): boolean {
    return this.inPaste;
  }

  reset(): void {
    this.inPaste = false;
    this.pastedChars = 0;
  }

  filter(data: string): { readonly text: string; readonly pasted: boolean } {
    const now = this.now();
    if (this.inPaste && (now - this.lastInputAt > PASTE_IDLE_MS || this.pastedChars > PASTE_MAX_CHARS)) {
      this.reset();
    }
    this.lastInputAt = now;

    let text = '';
    let pasted = this.inPaste;
    let rest = data;
    while (rest) {
      if (this.inPaste) {
        const end = rest.indexOf(PASTE_END);
        if (end < 0) {
          this.pastedChars += rest.length;
          return { text, pasted: true };
        }
        this.reset();
        rest = rest.slice(end + PASTE_END.length);
        continue;
      }
      const start = rest.indexOf(PASTE_START);
      if (start < 0) {
        text += rest;
        break;
      }
      text += rest.slice(0, start);
      this.inPaste = true;
      pasted = true;
      rest = rest.slice(start + PASTE_START.length);
    }
    return { text, pasted };
  }
}
