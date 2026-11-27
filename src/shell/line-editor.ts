import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ShellEvent, ShellInputLine } from './shell-markers.js';

/**
 * Reads and sets the shell's own input line, so Shelly can draw where the
 * user was typing and later hand back a command for them to edit or run.
 *
 * Shelly sends the shell keys no terminal sends (function keys with every
 * modifier held, which zle, readline and fish 4 can all bind), and the hooks
 * in shell-integration/ bind them to widgets that answer with a marker:
 *
 *   capture  report `line;<request>;<buffer>;<cursor>`, then clear the line
 *   set      replace the line with the line file, delete it, report `line-set;<request>`
 *   clear    bash 3.2: clear the line, so Shelly can type a new one
 *   redraw   bash 3.2: redraw the prompt and line where the cursor is
 *
 * Each request is numbered in the line file (`capture <n>`, or `set <n>
 * <cursor>` and the text), and the hooks echo the number back, so an answer
 * is matched to its request. Shelly withdraws the file of a request it gives
 * up on, so a late answer names none, and Shelly puts back the line it
 * reports (the shell has cleared it by then).
 *
 * The line file lives in a directory only the user can open, under a fresh
 * random name for each session, and exists only between Shelly writing it
 * and the shell reading it. The text travels through a file rather than as
 * keystrokes so that nothing in it (quotes, `$`, `!`, newlines, tabs) is ever
 * interpreted by the line editor, let alone run.
 *
 * What each shell gets:
 *   zsh, fish, bash 4+  capture and set
 *   bash 3.2            no READLINE_LINE, so no capture; replace clears the
 *                       line and types the text: as a bracketed paste when
 *                       the shell has turned that on, otherwise only single
 *                       lines, with control characters removed
 */

/** The keys Shelly sends. Kept in step with the bindings in shell-integration/. */
export const LINE_KEYS = {
  /** Ctrl+Alt+Shift+Meta+F12. */
  capture: '\u001b[24;16~',
  /** Ctrl+Alt+Shift+Meta+F11. */
  set: '\u001b[23;16~',
  /** Ctrl+Alt+Shift+Meta+F10. */
  clear: '\u001b[21;16~',
  /** Ctrl+Alt+Shift+Meta+F9. */
  redraw: '\u001b[20;16~',
} as const;

const LINE_KEY_PATTERN = new RegExp(
  Object.values(LINE_KEYS).map((key) => key.replace(/[[\]\\^$.|?*+()]/g, '\\$&')).join('|'),
  'g',
);

/** The input line, as Shelly took it from the shell. */
export interface CapturedLine {
  readonly buffer: string;
  /** Where the cursor was, as an index into `buffer` (UTF-16 code units). */
  readonly cursor: number;
}

export interface LineEditorOptions {
  /** Sends keys to the shell, as if typed. */
  readonly write: (data: string) => void;
  /** True when the shell itself, not a program it started, owns the terminal. */
  readonly isShellInForeground?: () => boolean;
  /** Where to make the private directory for the line file. Defaults to the system's temp directory. */
  readonly runtimeDir?: string;
  /** How long to wait for the shell to answer. */
  readonly timeoutMs?: number;
  /** After the line is captured, how long the shell's output must be quiet before its redraw counts as done. */
  readonly settleMs?: number;
}

const DEFAULT_TIMEOUT_MS = 1000;
const DEFAULT_SETTLE_MS = 30;
/** However busy the output, a capture is done this long after the shell answered. */
const MAX_SETTLE_MS = 300;

const BRACKETED_PASTE_MODE = /\u001b\[\?2004([hl])/g;
const PASTE_START = '\u001b[200~';
const PASTE_END = '\u001b[201~';
/** C0 and C1 controls and DEL, except tab and line feed. */
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

/** Requests given up on, remembered so their late answers can be told from repeats. */
const MAX_ABANDONED = 16;

interface PendingCapture {
  readonly request: number;
  readonly resolve: (line: ShellInputLine | undefined) => void;
  readonly timer: NodeJS.Timeout;
  /** Set once the shell has answered; resolved when its output goes quiet. */
  answer?: { readonly line: ShellInputLine | undefined; readonly deadline: number };
  settleTimer?: NodeJS.Timeout;
}

interface PendingSet {
  readonly request: number;
  readonly resolve: () => void;
  readonly timer: NodeJS.Timeout;
}

export class LineEditor {
  /** The file the hooks read new lines from; undefined if its directory could not be made. */
  readonly lineFile: string | undefined;
  private readonly lineDir: string | undefined;
  private readonly write: (data: string) => void;
  private readonly isShellInForeground: () => boolean;
  private readonly timeoutMs: number;
  private readonly settleMs: number;
  private features = new Set<string>();
  private atPrompt = false;
  private bracketedPaste = false;
  private pendingCapture: PendingCapture | undefined;
  private pendingSet: PendingSet | undefined;
  private nextRequest = 1;
  private readonly abandoned = new Set<number>();
  /** Inside a bracketed paste the user is sending, which may span chunks. */
  private inPaste = false;
  /** Operations run one at a time; the tail of the queue. */
  private tail: Promise<unknown> = Promise.resolve();
  private inFlight = 0;
  private disposed = false;

  constructor(options: LineEditorOptions) {
    this.write = options.write;
    this.isShellInForeground = options.isShellInForeground ?? (() => true);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.settleMs = options.settleMs ?? DEFAULT_SETTLE_MS;
    try {
      // mkdtemp makes the directory 0700.
      this.lineDir = mkdtempSync(join(options.runtimeDir ?? tmpdir(), 'shelly-'));
      this.lineFile = join(this.lineDir, `line-${randomBytes(12).toString('hex')}`);
    } catch {
      this.lineDir = undefined;
      this.lineFile = undefined;
    }
  }

  /** The shell can report its line (and clear it). */
  get canCapture(): boolean {
    return this.features.has('capture') && this.lineFile !== undefined;
  }

  /** The shell's line can be replaced: set exactly, or failing that, cleared and typed. */
  get canReplace(): boolean {
    return this.canSet || this.features.has('clear');
  }

  /**
   * The shell is waiting at its prompt: it has drawn one (`cwd`) and not
   * started a command since, and nothing else owns the terminal.
   */
  get isAtPrompt(): boolean {
    return this.atPrompt && !this.disposed && this.isShellInForeground();
  }

  private get canSet(): boolean {
    return this.features.has('set') && this.lineFile !== undefined;
  }

  /** Every event from the shell's markers. */
  handleEvent(event: ShellEvent): void {
    switch (event.type) {
      case 'line-editor':
        this.features = new Set(event.features);
        break;
      case 'cwd':
        this.atPrompt = true;
        break;
      case 'exec':
        this.atPrompt = false;
        break;
      case 'line':
        this.handleLine(event.request, event.line);
        break;
      case 'line-set':
        if (this.pendingSet && event.request === this.pendingSet.request) {
          clearTimeout(this.pendingSet.timer);
          this.pendingSet.resolve();
          this.pendingSet = undefined;
        }
        break;
      case 'done':
        break;
    }
  }

  /** Every piece of shell output (markers removed), in order. */
  observeOutput(data: string): void {
    if (data.includes('\u001b[?2004')) {
      for (const match of data.matchAll(BRACKETED_PASTE_MODE)) {
        this.bracketedPaste = match[1] === 'h';
      }
    }
    const capture = this.pendingCapture;
    if (capture?.answer) {
      this.settle(capture);
    }
  }

  /**
   * Keystrokes on their way to the shell. Removes Shelly's private keys
   * while the shell is at its prompt, so typing one cannot set off a widget,
   * and notes Enter, after which the shell may have started a command.
   */
  filterInput(data: string): string {
    // A pasted newline is text, not Enter.
    const typed = this.outsidePaste(data);
    if (!this.atPrompt) {
      return data;
    }
    if (/[\r\n]/.test(typed)) {
      this.atPrompt = false;
    }
    return data.includes('\u001b[') ? data.replace(LINE_KEY_PATTERN, '') : data;
  }

  /**
   * Take the shell's input line and clear it. Undefined when the shell is
   * not at its prompt, cannot report its line, or does not answer in time;
   * the line is then left as it was.
   */
  capture(): Promise<CapturedLine | undefined> {
    return this.enqueue(async () => {
      if (!this.canCapture || !this.isAtPrompt) {
        return undefined;
      }
      const file = this.lineFile!;
      const request = this.nextRequest++;
      writeRequest(file, `capture ${request}\n`);
      const line = await new Promise<ShellInputLine | undefined>((resolve) => {
        const timer = setTimeout(() => {
          this.pendingCapture = undefined;
          this.abandon(request);
          removeFile(file);
          resolve(undefined);
        }, this.timeoutMs);
        this.pendingCapture = { request, resolve, timer };
        this.write(LINE_KEYS.capture);
      });
      // The hooks remove it once read; this covers a shell that never did.
      removeFile(file);
      return line && { buffer: line.buffer, cursor: codePointsToIndex(line.buffer, line.cursor) };
    });
  }

  /**
   * Put `text` on the shell's input line in place of whatever is there, with
   * the cursor at the end. Nothing runs. Rejects if the shell is not at its
   * prompt, cannot take the text, or does not answer in time.
   */
  replace(text: string): Promise<void> {
    return this.setLine(text, text.length);
  }

  /** Put a captured line back as it was, cursor included (after the user cancels, say). */
  restore(captured: CapturedLine): Promise<void> {
    return this.setLine(captured.buffer, captured.cursor);
  }

  /**
   * Have a shell that cannot capture its line redraw the prompt and line
   * where the cursor is now (below something Shelly printed). False if it
   * cannot.
   */
  redraw(): boolean {
    if (!this.features.has('redraw') || !this.isAtPrompt) {
      return false;
    }
    this.write(LINE_KEYS.redraw);
    return true;
  }

  /** Stop waiting for the shell and remove the line file's directory. */
  dispose(): void {
    this.disposed = true;
    if (this.pendingCapture) {
      clearTimeout(this.pendingCapture.timer);
      clearTimeout(this.pendingCapture.settleTimer);
      this.pendingCapture.resolve(undefined);
      this.pendingCapture = undefined;
    }
    if (this.pendingSet) {
      clearTimeout(this.pendingSet.timer);
      this.pendingSet.resolve();
      this.pendingSet = undefined;
    }
    if (this.lineDir) {
      rmSync(this.lineDir, { recursive: true, force: true });
    }
  }

  /**
   * Starts at once when nothing else is in flight, so the keys it sends
   * reach the shell ahead of anything the caller forwards next.
   */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = this.inFlight === 0 ? task() : this.tail.then(task, task);
    this.inFlight++;
    const done = (): void => {
      this.inFlight--;
    };
    this.tail = result.then(done, done);
    return result;
  }

  private handleLine(request: number | undefined, line: ShellInputLine | undefined): void {
    const capture = this.pendingCapture;
    if (capture && !capture.answer && request === capture.request) {
      clearTimeout(capture.timer);
      capture.answer = { line, deadline: Date.now() + MAX_SETTLE_MS };
      this.settle(capture);
      return;
    }
    // An answer to a request Shelly gave up on: no request (its file was
    // withdrawn first) or one it abandoned. The shell has cleared the line,
    // so put it straight back. Anything else repeats an answer already taken.
    const late = request === undefined || this.abandoned.delete(request);
    if (late && line?.buffer && this.canSet) {
      this.setLine(line.buffer, codePointsToIndex(line.buffer, line.cursor)).catch(() => undefined);
    }
  }

  private abandon(request: number): void {
    this.abandoned.add(request);
    if (this.abandoned.size > MAX_ABANDONED) {
      this.abandoned.delete(this.abandoned.values().next().value!);
    }
  }

  /** The parts of the user's input outside bracketed pastes, following pastes across chunks. */
  private outsidePaste(data: string): string {
    if (!this.inPaste && !data.includes('\u001b[200~')) {
      return data;
    }
    let outside = '';
    let index = 0;
    while (index < data.length) {
      if (this.inPaste) {
        const end = data.indexOf(PASTE_END, index);
        if (end === -1) {
          break;
        }
        this.inPaste = false;
        index = end + PASTE_END.length;
      } else {
        const start = data.indexOf(PASTE_START, index);
        if (start === -1) {
          outside += data.slice(index);
          break;
        }
        outside += data.slice(index, start);
        this.inPaste = true;
        index = start + PASTE_START.length;
      }
    }
    return outside;
  }

  /** The shell redraws its cleared line right after answering; wait for that to reach the screen. */
  private settle(capture: PendingCapture): void {
    clearTimeout(capture.settleTimer);
    const answer = capture.answer!;
    const delay = Math.max(0, Math.min(this.settleMs, answer.deadline - Date.now()));
    capture.settleTimer = setTimeout(() => {
      if (this.pendingCapture === capture) {
        this.pendingCapture = undefined;
        capture.resolve(answer.line);
      }
    }, delay);
  }

  private setLine(text: string, cursor: number): Promise<void> {
    return this.enqueue(async () => {
      if (this.disposed || !this.isAtPrompt) {
        throw new Error('The shell is not at its prompt.');
      }
      if (this.canSet) {
        await this.setThroughFile(text.replaceAll('\u0000', ''), cursor);
      } else if (this.features.has('clear')) {
        this.typeLine(text);
      } else {
        throw new Error("This shell's input line cannot be set.");
      }
    });
  }

  private async setThroughFile(text: string, cursor: number): Promise<void> {
    const file = this.lineFile!;
    const codePoints = Array.from(text.slice(0, Math.max(0, cursor))).length;
    const request = this.nextRequest++;
    writeRequest(file, `set ${request} ${codePoints}\n${text}`);
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pendingSet = undefined;
          reject(new Error('The shell did not take the new line.'));
        }, this.timeoutMs);
        this.pendingSet = { request, resolve, timer };
        this.write(LINE_KEYS.set);
      });
    } finally {
      // The hooks remove it once read; this covers a shell that never did.
      removeFile(file);
    }
  }

  /** Without a way to set the line, clear it and type the text. */
  private typeLine(text: string): void {
    if (this.bracketedPaste) {
      const pasted = text.replace(/\r\n?/g, '\n').replace(CONTROL_CHARACTERS, '');
      this.write(`${LINE_KEYS.clear}\u001b[200~${pasted}\u001b[201~`);
      return;
    }
    if (/[\r\n]/.test(text)) {
      throw new Error("This shell can only take a single-line command on its input line.");
    }
    // Typed raw, a tab would start completion.
    this.write(LINE_KEYS.clear + text.replace(/\t/g, ' ').replace(CONTROL_CHARACTERS, ''));
  }
}

/** The index in `text` (UTF-16) of the code point at position `count`. */
const codePointsToIndex = (text: string, count: number): number => {
  let index = 0;
  let seen = 0;
  for (const character of text) {
    if (seen === count) {
      break;
    }
    index += character.length;
    seen++;
  }
  return index;
};

/** A fresh file only the user can read; `wx` never writes through something already at that path. */
const writeRequest = (file: string, content: string): void => {
  removeFile(file);
  writeFileSync(file, content, { mode: 0o600, flag: 'wx' });
};

const removeFile = (file: string): void => {
  try {
    unlinkSync(file);
  } catch {
    // Already gone.
  }
};
