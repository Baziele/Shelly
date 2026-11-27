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
