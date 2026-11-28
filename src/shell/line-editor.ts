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
 *   query    report `query;<request>;<buffer>;<cursor>`, leaving the line alone
 *   set      replace the line with the line file, delete it, report `line-set;<request>`
 *   notice   show the line file's one-line notice below the line, delete it,
 *            report `line-set;<request>`
 *   clear    bash 3.2: clear the line, so Shelly can type a new one
 *   mark, start, end, back
 *            bash 3.2: remember where the cursor is (readline's mark), move
 *            it to the start of the line and then its end, and later back to
 *            the mark. Nothing on the line changes; Shelly asks the terminal
 *            where the end is, to show its own notice below the line. Going
 *            by the start means the shell always moves the cursor, so its
 *            output says it has (unless the line is empty)
 *
 * Each request is numbered in the line file (`capture <n>`, `set <n>
 * <cursor>` and the text, or `notice <n>` and the text), and the hooks echo the number back, so an answer
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
 *   zsh, fish, bash 4+  capture, query, set and notice
 *   bash 3.2            no READLINE_LINE, so no capture or query; replace clears the
 *                       line and types the text: as a bracketed paste when
 *                       the shell has turned that on, otherwise only single
 *                       lines, with control characters removed; jump
 */

/** The keys Shelly sends. Kept in step with the bindings in shell-integration/. */
export const LINE_KEYS = {
  /** Ctrl+Alt+Shift+Meta+F12. */
  capture: '\u001b[24;16~',
  /** Ctrl+Alt+Shift+Meta+F11. */
  set: '\u001b[23;16~',
  /** Ctrl+Alt+Shift+Meta+F10. */
  clear: '\u001b[21;16~',
  /** Ctrl+Alt+Shift+Meta+F8. */
  notice: '\u001b[19;16~',
  /** Ctrl+Alt+Shift+Meta+F7. */
  mark: '\u001b[18;16~',
  /** Ctrl+Alt+Shift+Meta+F6. */
  start: '\u001b[17;16~',
  /** Ctrl+Alt+Shift+Meta+F5. */
  end: '\u001b[15;16~',
  /** Ctrl+Alt+Shift+Meta+F4. */
  back: '\u001b[1;16S',
  /** Ctrl+Alt+Shift+Meta+F9. */
  query: '\u001b[20;16~',
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

/** How a capture went. */
export type CaptureResult =
  | { readonly status: 'captured'; readonly line: CapturedLine }
  /** The shell cannot report its line, or is not at its prompt. The line is untouched. */
  | { readonly status: 'unsupported' }
  /**
   * The shell has the line but could not report it (`too-long`: it is left
   * as it is), or did not answer in time (`no-answer`: if the shell answers
   * later, it has cleared the line, and Shelly puts it back then).
   */
  | { readonly status: 'failed'; readonly reason: 'too-long' | 'no-answer' };

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
  /**
   * After an Enter, how long the shell may stay quiet without starting a
   * command before it counts as still at its prompt.
   */
  readonly enterQuietMs?: number;
  /**
   * After the keys that move the cursor to the line's end (bash 3.2), how
   * long to wait for the shell's output to start; after that, it is done
   * once the output has been quiet for `settleMs`.
   */
  readonly moveStartMs?: number;
}

const DEFAULT_TIMEOUT_MS = 1000;
/**
 * A query holds back a keystroke, so it gives up soon. A shell at its prompt
 * answers in a few milliseconds; one this slow is busy, and the key goes on.
 */
const DEFAULT_QUERY_TIMEOUT_MS = 100;
const DEFAULT_SETTLE_MS = 30;
/**
 * A shell reports a command (`exec`) as soon as it takes the line, so after
 * this long with nothing from it, the Enter did not run one.
 */
const DEFAULT_ENTER_QUIET_MS = 300;
/** However busy the output, a capture is done this long after the shell answered. */
const MAX_SETTLE_MS = 300;
/**
 * A cursor move (bash 3.2) has no answer. The move to the line's end always
 * makes the shell write something, unless the line is empty: it is done once
 * that output has been quiet for the settle time, and given up on with no
 * output after this long.
 */
const DEFAULT_MOVE_START_MS = 500;
/** However busy the output, a cursor move is done this long after the keys went. */
const MAX_MOVE_MS = 1000;

const BRACKETED_PASTE_MODE = /\u001b\[\?2004([hl])/g;
const PASTE_START = '\u001b[200~';
const PASTE_END = '\u001b[201~';
/** C0 and C1 controls and DEL, except tab and line feed. */
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

/** Requests given up on, remembered so their late answers can be told from repeats. */
const MAX_ABANDONED = 16;

interface PendingCapture {
  readonly request: number;
  /** Undefined when the shell did not answer in time. */
  readonly resolve: (answer: { readonly line: ShellInputLine | undefined } | undefined) => void;
  readonly timer: NodeJS.Timeout;
  /** Set once the shell has answered; resolved when its output goes quiet. */
  answer?: { readonly line: ShellInputLine | undefined; readonly deadline: number };
  settleTimer?: NodeJS.Timeout;
}

/**
 * How a cursor move went: `moved` once the shell's output for it went quiet,
 * `silent` if the shell wrote nothing (an empty line, or a shell too slow to
 * tell), `unsupported` if the keys were not sent.
 */
export type MoveResult = 'moved' | 'silent' | 'unsupported';

interface PendingMove {
  readonly resolve: (sawOutput: boolean) => void;
  readonly deadline: number;
  sawOutput: boolean;
  timer?: NodeJS.Timeout;
}

interface PendingQuery {
  readonly request: number;
  /** Undefined when the shell did not answer in time. */
  readonly resolve: (answer: { readonly line: ShellInputLine | undefined } | undefined) => void;
  readonly timer: NodeJS.Timeout;
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
  private readonly enterQuietMs: number;
  private readonly moveStartMs: number;
  private pendingMove: PendingMove | undefined;
  private outputs = 0;
  private features = new Set<string>();
  /** The shell has drawn a prompt (`cwd`) and not started a command (`exec`) since. */
  private atPrompt = false;
  /**
   * Set from an Enter at the prompt until the shell starts a command, draws
   * a new prompt, or stays quiet for `enterQuietMs`: an Enter that continues
   * the line (an open quote, a trailing `\`) or accepts a completion menu or
   * a history search leaves the shell at the same prompt, with no marker.
   */
  private enterTimer: NodeJS.Timeout | undefined;
  /** Waiting for the shell to say what the Enter did; see `decided`. */
  private decidedWaiters: (() => void)[] = [];
  private bracketedPaste = false;
  private pendingCapture: PendingCapture | undefined;
  private pendingSet: PendingSet | undefined;
  private pendingQuery: PendingQuery | undefined;
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
    this.enterQuietMs = options.enterQuietMs ?? DEFAULT_ENTER_QUIET_MS;
    this.moveStartMs = options.moveStartMs ?? DEFAULT_MOVE_START_MS;
    try {
      // mkdtemp makes the directory 0700.
      this.lineDir = mkdtempSync(join(options.runtimeDir ?? tmpdir(), 'shelly-'));
      removeOnExit(this.lineDir);
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

  /**
   * A shell that cannot capture its line can move its cursor to the line's
   * end and back, leaving the line as it is (bash 3.2).
   */
  get canJump(): boolean {
    return this.features.has('jump');
  }

  /** The shell can report its line and leave it as it is. */
  get canQuery(): boolean {
    return this.features.has('query') && this.lineFile !== undefined;
  }

  /** The shell can show a notice below its line, leaving the line alone. */
  get canNotify(): boolean {
    return this.features.has('notice') && this.lineFile !== undefined;
  }

  /** The shell's line can be replaced: set exactly, or failing that, cleared and typed. */
  get canReplace(): boolean {
    return this.canSet || this.features.has('clear');
  }

  /**
   * The shell is waiting at its prompt: it has drawn one (`cwd`) and not
   * started a command since, is not just taking an Enter, and nothing else
   * owns the terminal.
   */
  get isAtPrompt(): boolean {
    return this.atPrompt && this.enterTimer === undefined && !this.disposed && this.isShellInForeground();
  }

  /**
   * The shell has taken an Enter at its prompt and not yet said what it did:
   * started a command, drawn a new prompt, or (by staying quiet) neither.
   */
  get isDeciding(): boolean {
    return this.atPrompt && this.enterTimer !== undefined && !this.disposed;
  }

  /**
   * Resolves once the shell has said what an Enter did (at once if there is
   * none pending), so a key that needs to know can wait for it rather than
   * for the clock.
   */
  decided(): Promise<void> {
    if (!this.isDeciding) {
      return Promise.resolve();
    }
    return new Promise((resolve) => this.decidedWaiters.push(resolve));
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
        this.clearEnter();
        break;
      case 'exec':
        this.atPrompt = false;
        this.clearEnter();
        break;
      case 'line':
        this.handleLine(event.request, event.line);
        break;
      case 'line-query':
        // A late answer is of no use to anyone, and the line was left alone.
        if (this.pendingQuery && event.request === this.pendingQuery.request) {
          clearTimeout(this.pendingQuery.timer);
          this.pendingQuery.resolve({ line: event.line });
          this.pendingQuery = undefined;
        }
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
    // Still busy with the Enter: wait for it to go quiet.
    this.enterTimer?.refresh();
    const capture = this.pendingCapture;
    if (capture?.answer) {
      this.settle(capture);
    }
    this.outputs++;
    if (this.pendingMove) {
      this.pendingMove.sawOutput = true;
      this.waitForQuiet(this.pendingMove, this.settleMs);
    }
  }

  /** How many pieces of shell output have come so far: compare two to tell whether any came between. */
  get outputCount(): number {
    return this.outputs;
  }

  /**
   * Keystrokes on their way to the shell. Removes Shelly's private keys
   * until the shell reports a command, so typing one cannot set off a
   * widget, and notes Enter, after which the shell may be starting one.
   */
  filterInput(data: string): string {
    // A pasted newline is text, not Enter.
    const typed = this.outsidePaste(data);
    if (!this.atPrompt) {
      return data;
    }
    if (/[\r\n]/.test(typed) && !this.disposed) {
      // Until the shell says what the Enter did. The keys are still removed
      // meanwhile: whatever the shell starts, nothing it runs needs them.
      clearTimeout(this.enterTimer);
      this.enterTimer = setTimeout(() => {
        this.clearEnter();
      }, this.enterQuietMs);
      this.enterTimer.unref();
    }
    return data.includes('\u001b[') ? data.replace(LINE_KEY_PATTERN, '') : data;
  }

  /**
   * Take the shell's input line and clear it. Undefined when that did not
   * happen, for whatever reason; see `tryCapture` for which.
   */
  async capture(): Promise<CapturedLine | undefined> {
    const result = await this.tryCapture();
    return result.status === 'captured' ? result.line : undefined;
  }

  /** Take the shell's input line and clear it, saying what happened if not. */
  tryCapture(options: { readonly timeoutMs?: number } = {}): Promise<CaptureResult> {
    return this.enqueue(async (): Promise<CaptureResult> => {
      if (!this.canCapture || !this.isAtPrompt) {
        return { status: 'unsupported' };
      }
      const file = this.lineFile!;
      const request = this.nextRequest++;
      writeRequest(file, `capture ${request}\n`);
      const answer = await new Promise<{ readonly line: ShellInputLine | undefined } | undefined>((resolve) => {
        const timer = setTimeout(() => {
          this.pendingCapture = undefined;
          this.abandon(request);
          removeFile(file);
          resolve(undefined);
        }, options.timeoutMs ?? this.timeoutMs);
        this.pendingCapture = { request, resolve, timer };
        this.write(LINE_KEYS.capture);
      });
      // The hooks remove it once read; this covers a shell that never did.
      removeFile(file);
      if (!answer) {
        return { status: 'failed', reason: 'no-answer' };
      }
      if (!answer.line) {
        return { status: 'failed', reason: 'too-long' };
      }
      const { buffer, cursor } = answer.line;
      return { status: 'captured', line: { buffer, cursor: codePointsToIndex(buffer, cursor) } };
    });
  }

  /**
   * Ask for the shell's input line and cursor, leaving both as they are (to
   * learn whether the line is empty, say). Gives up quickly: see
   * DEFAULT_QUERY_TIMEOUT_MS.
   */
  query(options: { readonly timeoutMs?: number } = {}): Promise<CaptureResult> {
    return this.enqueue(async (): Promise<CaptureResult> => {
      if (!this.canQuery || !this.isAtPrompt) {
        return { status: 'unsupported' };
      }
      const file = this.lineFile!;
      const request = this.nextRequest++;
      writeRequest(file, `query ${request}\n`);
      const answer = await new Promise<{ readonly line: ShellInputLine | undefined } | undefined>((resolve) => {
        const timer = setTimeout(() => {
          this.pendingQuery = undefined;
          resolve(undefined);
        }, options.timeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS);
        this.pendingQuery = { request, resolve, timer };
        this.write(LINE_KEYS.query);
      });
      // The hooks remove it once read; this withdraws it from a shell that has not.
      removeFile(file);
      if (!answer) {
        return { status: 'failed', reason: 'no-answer' };
      }
      if (!answer.line) {
        return { status: 'failed', reason: 'too-long' };
      }
      const { buffer, cursor } = answer.line;
      return { status: 'captured', line: { buffer, cursor: codePointsToIndex(buffer, cursor) } };
    });
  }

  /**
   * Have the shell show a one-line notice below its line, which stays as it
   * is. Rejects if the shell cannot, is not at its prompt, or does not
   * answer in time.
   */
  notify(text: string): Promise<void> {
    return this.enqueue(async () => {
      if (!this.canNotify || this.disposed || !this.isAtPrompt) {
        throw new Error('The shell cannot show a notice now.');
      }
      const line = text.replace(/[\r\n\t]+/g, ' ').replace(CONTROL_CHARACTERS, '');
      await this.sendThroughFile(LINE_KEYS.notice, (request) => `notice ${request}\n${line}`);
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
   * bash 3.2: remember where the shell's cursor is, then move it to the end
   * of the line, by way of its start. Resolves once the move has reached the
   * screen; see `MoveResult`.
   */
  jumpToLineEnd(): Promise<MoveResult> {
    return this.move(LINE_KEYS.mark + LINE_KEYS.start + LINE_KEYS.end, this.moveStartMs);
  }

  /**
   * bash 3.2: move the shell's cursor back to where `jumpToLineEnd` found it.
   * It may already be there (it was at the end), so a short wait for output.
   */
  jumpBack(): Promise<MoveResult> {
    return this.move(LINE_KEYS.back, this.settleMs);
  }

  /** Stop waiting for the shell and remove the line file's directory. */
  dispose(): void {
    this.disposed = true;
    this.clearEnter();
    if (this.pendingMove) {
      clearTimeout(this.pendingMove.timer);
      this.pendingMove.resolve(false);
      this.pendingMove = undefined;
    }
    if (this.pendingCapture) {
      clearTimeout(this.pendingCapture.timer);
      clearTimeout(this.pendingCapture.settleTimer);
      this.pendingCapture.resolve(this.pendingCapture.answer);
      this.pendingCapture = undefined;
    }
    if (this.pendingSet) {
      clearTimeout(this.pendingSet.timer);
      this.pendingSet.resolve();
      this.pendingSet = undefined;
    }
    if (this.pendingQuery) {
      clearTimeout(this.pendingQuery.timer);
      this.pendingQuery.resolve(undefined);
      this.pendingQuery = undefined;
    }
    if (this.lineDir) {
      liveDirs.delete(this.lineDir);
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

  private clearEnter(): void {
    clearTimeout(this.enterTimer);
    this.enterTimer = undefined;
    const waiters = this.decidedWaiters;
    this.decidedWaiters = [];
    for (const resolve of waiters) {
      resolve();
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
        capture.resolve(answer);
      }
    }, delay);
  }

  /**
   * Send keys that only move the cursor; done once the shell's output for
   * them has gone quiet, or with none after `startMs`.
   */
  private move(keys: string, startMs: number): Promise<MoveResult> {
    return this.enqueue(async (): Promise<MoveResult> => {
      if (!this.canJump || !this.isAtPrompt) {
        return 'unsupported';
      }
      const sawOutput = await new Promise<boolean>((resolve) => {
        const move: PendingMove = { resolve, deadline: Date.now() + MAX_MOVE_MS, sawOutput: false };
        this.pendingMove = move;
        this.write(keys);
        this.waitForQuiet(move, startMs);
      });
      return sawOutput ? 'moved' : 'silent';
    });
  }

  private waitForQuiet(move: PendingMove, quietMs: number): void {
    clearTimeout(move.timer);
    const delay = Math.max(0, Math.min(quietMs, move.deadline - Date.now()));
    move.timer = setTimeout(() => {
      if (this.pendingMove === move) {
        this.pendingMove = undefined;
      }
      move.resolve(move.sawOutput);
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
    const codePoints = Array.from(text.slice(0, Math.max(0, cursor))).length;
    await this.sendThroughFile(LINE_KEYS.set, (request) => `set ${request} ${codePoints}\n${text}`);
  }

  /** Leave a numbered request in the line file, send its key, and wait for the shell to say it is done. */
  private async sendThroughFile(key: string, content: (request: number) => string): Promise<void> {
    const file = this.lineFile!;
    const request = this.nextRequest++;
    writeRequest(file, content(request));
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pendingSet = undefined;
          reject(new Error('The shell did not answer.'));
        }, this.timeoutMs);
        this.pendingSet = { request, resolve, timer };
        this.write(key);
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

/** Line file directories not yet disposed of, removed if the process exits first (a crash, say). */
const liveDirs = new Set<string>();
let exitHookInstalled = false;

const removeOnExit = (dir: string): void => {
  liveDirs.add(dir);
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    // `exit` handlers must be synchronous; this is the last chance.
    process.on('exit', () => {
      for (const live of liveDirs) {
        try {
          rmSync(live, { recursive: true, force: true });
        } catch {
          // Best effort.
        }
      }
      liveDirs.clear();
    });
  }
};

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
