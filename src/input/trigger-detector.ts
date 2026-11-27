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
 */

export type TriggerAction =
  | { readonly type: 'forward'; readonly data: string }
  | { readonly type: 'trigger'; readonly trigger: string; readonly remainder: string };

export interface TriggerDetectorOptions {
  readonly triggers: readonly string[];
  /** Asked when a trigger could begin. Return false to treat the keystroke as ordinary input. */
  readonly isEnabled?: () => boolean;
}

const CARRIAGE_RETURN = '\r';
const LINE_FEED = '\n';
const CTRL_C = '\u0003';
const CTRL_U = '\u0015';
const BACKSPACE = '\b';
const DELETE = '\u007f';

export class TriggerDetector {
  private readonly triggers: readonly string[];
  private readonly isEnabled: () => boolean;
  private held = '';
  /** The line holds text we could not track (cursor movement, completion, history…). */
  private lineUnknown = false;
  /** Characters typed on the current line, valid while the line is not unknown. */
  private typedLength = 0;

  constructor(options: TriggerDetectorOptions) {
    if (options.triggers.some((trigger) => trigger.length === 0)) {
      throw new Error('Triggers must not be empty.');
    }
    this.triggers = options.triggers;
    this.isEnabled = options.isEnabled ?? (() => true);
  }

  /** Characters are being held back while a trigger may still be forming. */
  get isHolding(): boolean {
    return this.held.length > 0;
  }

  push(input: string): TriggerAction[] {
    const actions: TriggerAction[] = [];
    const characters = Array.from(input);
    let forward = '';

    for (let index = 0; index < characters.length; index++) {
      const character = characters[index]!;

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

  private get isLineEmpty(): boolean {
    return !this.lineUnknown && this.typedLength === 0;
  }

  private couldStartTrigger(character: string): boolean {
    return this.triggers.some((trigger) => trigger.startsWith(character));
  }

  private isTriggerPrefix(text: string): boolean {
    return this.triggers.some((trigger) => trigger.length > text.length && trigger.startsWith(text));
  }

  private track(text: string): void {
    for (const character of text) {
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
            this.lineUnknown = true;
          } else if (!this.lineUnknown) {
            this.typedLength++;
          }
      }
    }
  }
}
