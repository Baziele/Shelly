/**
 * Watches keystrokes headed for the shell and recognises the sequence that
 * hands the input line to Shelly (for example `::`).
 *
 * A trigger only counts when it is typed at the start of an empty shell input
 * line, so `std::vector` or `a::b` reach the shell untouched. While a trigger
 * could still be forming, its first characters are held back rather than
 * forwarded; the caller should call `release()` if nothing follows promptly.
 *
 * The detector cannot see the shell's line editor, so it infers "empty line"
 * from keystrokes: Enter and Ctrl+C start a fresh line, printable characters
 * and backspaces are counted, and anything else (arrow keys, Tab, history
 * search, pastes) marks the line as unknown until the next fresh line.
 * Replies the terminal sends to the shell's own queries (fish asks for device
 * attributes and colors at every prompt, for one) travel the same way but are
 * not keystrokes, so they pass through without counting.
 *
 * When the line is unknown only because of plain editing keys (arrows,
 * Home/End, history up and down, Ctrl+A/E/K/U/W and the like), a character
 * that could start a trigger comes back as an `ask` action instead: the
 * caller asks the shell for its line (LineEditor.query), says what it heard
 * (`markLineEmpty`, `markLineTyped`, or nothing), and pushes the held input
 * again with `mayAsk: false`. After keys that may leave the line editor in a
 * mode of its own (Tab and its menus, history search, Esc into vi command
 * mode, a key prefix such as Ctrl+X, a paste) it does not ask, since the key
 * the question takes would end or change that mode; the line stays unknown
 * until a fresh one, as it does in shells that cannot answer (bash 3.2).
 */

export type TriggerAction =
  | { readonly type: 'forward'; readonly data: string }
  | { readonly type: 'trigger'; readonly trigger: string; readonly remainder: string }
  /**
   * A trigger could begin on a line whose contents are unknown: ask the
   * shell, then push `pending` (the rest of the input, that character first)
   * again with `mayAsk: false`.
   */
  | { readonly type: 'ask'; readonly pending: string };

export interface TriggerDetectorOptions {
  readonly triggers: readonly string[];
  /** Asked when a trigger could begin. Return false to treat the keystroke as ordinary input. */
  readonly isEnabled?: () => boolean;
  /** Whether the shell can be asked for its line right now. Without it, an unknown line stays unknown. */
  readonly canAskLine?: () => boolean;
}

const CARRIAGE_RETURN = '\r';
const LINE_FEED = '\n';
const CTRL_C = '\u0003';
const CTRL_U = '\u0015';
const BACKSPACE = '\b';
const DELETE = '\u007f';

/**
 * Sequences only a terminal sends, in reply to a query or to report an event:
 * CSI with a private marker (device attributes, mode and keyboard-protocol
 * reports, SGR mouse), cursor position reports, focus in/out, window reports,
 * and OSC/DCS/APC strings (colors, capabilities). No key produces these.
 */
const TERMINAL_REPORT = new RegExp(
  [
    '\\u001b\\[[?>=<][0-9;:$]*[A-Za-z~]',
    '\\u001b\\[\\d+;\\d+R',
    '\\u001b\\[[IO]',
    '\\u001b\\[[0-9;]*t',
    '\\u001b\\][^\\u0007\\u001b]*(?:\\u0007|\\u001b\\\\)',
    '\\u001b[P_^][^\\u001b]*\\u001b\\\\',
  ].join('|'),
  'gu',
);

/** Key sequences: CSI and SS3 (arrows, Home, Delete, function keys…) and Alt+key. */
const KEY_SEQUENCE = /\u001b\[[0-9;]*[ -/]*[@-~]|\u001bO[A-Za-z]|\u001b[^\u001b[O]/gu;

/**
 * Keys that move the cursor or edit the line and nothing more: after these
 * the shell can be asked for its line without disturbing anything. Up and
 * Down recall history; Ctrl+B/F/A/E move; Ctrl+D/H/K/U/W/Y, Delete and
 * Backspace edit; Ctrl+L clears the screen; Ctrl+N/P recall history; Ctrl+_
 * undoes; Alt+B/F move by words and Alt+D/Backspace delete them.
 */
const PLAIN_EDITING_KEY =
  /^(?:\u001b\[(?:1;\d+)?[ABCDHF]|\u001bO[ABCDHF]|\u001b\[[1-8](?:;\d+)?~|\u001b[bfd\u007f\b]|[\u0001\u0002\u0004\u0005\u0006\u0008\u000b\u000c\u000e\u0010\u0015\u0017\u0019\u001f\u007f])$/u;

interface Token {
  readonly text: string;
  /** A reply from the terminal, not a key. */
  readonly report: boolean;
}

/** Code points, except that terminal reports and key sequences stay whole. */
const tokenize = (input: string): Token[] => {
  const tokens: Token[] = [];
  const characters = (text: string, report: boolean): void => {
    let cursor = 0;
    if (!report) {
      for (const match of text.matchAll(KEY_SEQUENCE)) {
        tokens.push(...Array.from(text.slice(cursor, match.index), (character) => ({ text: character, report: false })));
        tokens.push({ text: match[0], report: false });
        cursor = match.index + match[0].length;
      }
    }
    tokens.push(...Array.from(text.slice(cursor), (character) => ({ text: character, report: false })));
  };
  let cursor = 0;
  for (const match of input.matchAll(TERMINAL_REPORT)) {
    characters(input.slice(cursor, match.index), false);
    tokens.push({ text: match[0], report: true });
    cursor = match.index + match[0].length;
  }
  characters(input.slice(cursor), false);
  return tokens;
};

export class TriggerDetector {
  private readonly triggers: readonly string[];
  private readonly isEnabled: () => boolean;
  private held = '';
  private readonly canAskLine: () => boolean;
  /** The line holds text we could not track (cursor movement, completion, history…). */
  private lineUnknown = false;
  /** Unknown only through plain editing keys, so the shell may be asked (see PLAIN_EDITING_KEY). */
  private mayAskShell = false;
  /** Characters typed on the current line, valid while the line is not unknown. */
  private typedLength = 0;

  constructor(options: TriggerDetectorOptions) {
    if (options.triggers.some((trigger) => trigger.length === 0)) {
      throw new Error('Triggers must not be empty.');
    }
    this.triggers = options.triggers;
    this.isEnabled = options.isEnabled ?? (() => true);
    this.canAskLine = options.canAskLine ?? (() => false);
  }

  /** Characters are being held back while a trigger may still be forming. */
  get isHolding(): boolean {
    return this.held.length > 0;
  }

  /** `mayAsk: false` when pushing input held for an `ask` again: the answer is in. */
  push(input: string, { mayAsk = true }: { readonly mayAsk?: boolean } = {}): TriggerAction[] {
    const actions: TriggerAction[] = [];
    const tokens = tokenize(input);
    const characters = tokens.map((token) => token.text);
    let forward = '';

    for (let index = 0; index < tokens.length; index++) {
      const character = characters[index]!;

      if (tokens[index]!.report) {
        // Neither typed text nor an edit; a trigger being held keeps forming.
        forward += character;
        continue;
      }

      if (this.held) {
        const candidate = this.held + character;
        if (this.triggers.includes(candidate)) {
          this.held = '';
          if (forward) {
            actions.push({ type: 'forward', data: forward });
          }
          actions.push({ type: 'trigger', trigger: candidate, remainder: characters.slice(index + 1).join('') });
          return actions;
        }
        if (this.isTriggerPrefix(candidate)) {
          this.held = candidate;
          continue;
        }

        forward += this.held;
        this.track(this.held);
        this.held = '';
      }

      if (
        mayAsk &&
        this.lineUnknown &&
        this.mayAskShell &&
        this.couldStartTrigger(character) &&
        this.canAskLine() &&
        this.isEnabled()
      ) {
        if (forward) {
          actions.push({ type: 'forward', data: forward });
        }
        actions.push({ type: 'ask', pending: characters.slice(index).join('') });
        return actions;
      }

      if (this.isLineEmpty && this.couldStartTrigger(character) && this.isEnabled()) {
        if (this.triggers.includes(character)) {
          if (forward) {
            actions.push({ type: 'forward', data: forward });
          }
          actions.push({ type: 'trigger', trigger: character, remainder: characters.slice(index + 1).join('') });
          return actions;
        }
        this.held = character;
        continue;
      }

      forward += character;
      this.track(character);
    }

    if (forward) {
      actions.push({ type: 'forward', data: forward });
    }
    return actions;
  }

  /** Stop waiting for the rest of a trigger. Returns the held characters, which belong to the shell. */
  release(): string {
    const held = this.held;
    this.held = '';
    this.track(held);
    return held;
  }

  /** Tell the detector the shell's input line is empty, e.g. after Shelly hands control back. */
  markLineEmpty(): void {
    this.lineUnknown = false;
    this.typedLength = 0;
  }

  /**
   * Tell the detector the line holds `length` characters with the cursor at
   * the end (Shelly just set it), so deleting them all makes it empty again.
   */
  markLineTyped(length: number): void {
    this.lineUnknown = false;
    this.typedLength = length;
  }

  /**
   * Tell the detector the shell's input line holds text it did not see
   * typed, e.g. a line Shelly put back. The shell may be asked about it.
   */
  markLineUnknown(): void {
    this.lineUnknown = true;
    this.mayAskShell = true;
  }

  /** The shell's input line is known to be empty: nothing typed on it, or all of it deleted. */
  get isLineEmpty(): boolean {
    return !this.lineUnknown && this.typedLength === 0;
  }

  private couldStartTrigger(character: string): boolean {
    return this.triggers.some((trigger) => trigger.startsWith(character));
  }

  private isTriggerPrefix(text: string): boolean {
    return this.triggers.some((trigger) => trigger.length > text.length && trigger.startsWith(text));
  }

  private track(text: string): void {
    for (const { text: character } of tokenize(text)) {
      switch (character) {
        case CARRIAGE_RETURN:
        case LINE_FEED:
        case CTRL_C:
          this.markLineEmpty();
          break;
        case CTRL_U:
          if (!this.lineUnknown) {
            this.typedLength = 0;
          }
          break;
        case BACKSPACE:
        case DELETE:
          if (!this.lineUnknown) {
            this.typedLength = Math.max(0, this.typedLength - 1);
          }
          break;
        default:
          if (character < ' ') {
            // Escape sequences and other control keys edit the line in ways we cannot follow.
            this.mayAskShell = (!this.lineUnknown || this.mayAskShell) && PLAIN_EDITING_KEY.test(character);
            this.lineUnknown = true;
          } else if (!this.lineUnknown) {
            this.typedLength++;
          }
      }
    }
  }
}
