import { ansi } from './ansi.js';
import { extractCursorReport, type CursorPosition } from './cursor-report.js';

export interface TerminalSize {
  readonly cols: number;
  readonly rows: number;
}

/** Where the cursor was pushed against the right edge: its row, and the terminal's width (see queryWidth). */
export interface WidthReport {
  readonly row: number;
  readonly cols: number;
}

interface PendingCursorQuery {
  /** `width`: asked at the right edge, after a frame (see queryWidth); `position`: where the cursor is. */
  readonly kind: 'position' | 'width';
  readonly promise: Promise<CursorPosition>;
  readonly resolve: (position: CursorPosition) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
  /** A plain report that may be Shift+F3 and friends, waiting to see whether a real one follows. */
  held?: { readonly text: string; readonly position: CursorPosition; readonly timer: NodeJS.Timeout };
}

/** How long an ambiguous plain report waits for a clearer one before it counts as the answer. */
const AMBIGUOUS_REPORT_WAIT_MS = 60;
/** Replies that arrive this long after a query was settled are still taken out of the input. */
const LATE_REPLY_WINDOW_MS = 3000;
/** While replies are owed, input ending in what may be the start of one waits this long for the rest. */
const PARTIAL_REPORT_WAIT_MS = 50;
/** The start of a cursor position report, cut off: ESC, ESC [, ESC [ ?, then digits and semicolons. */
const PARTIAL_REPORT = /\u001b(?:\[\??(?:\d+(?:;\d*(?:;\d*)?)?)?)?$/;

/** Terminals (by TERM_PROGRAM) that rewrap their rows when resized. */
const REFLOWING_PROGRAMS = new Set(['iTerm.app', 'Apple_Terminal', 'vscode', 'WezTerm', 'ghostty', 'Hyper', 'WarpTerminal', 'tmux', 'rio', 'Tabby']);

/**
 * Whether the terminal Shelly runs in rewraps rows when it is resized, as
 * far as its environment tells: true for the terminals known to (and tmux,
 * whatever runs it), false inside GNU screen (which does not), undefined
 * when there is no telling.
 */
export const terminalReflows = (env: NodeJS.ProcessEnv): boolean | undefined => {
  if (env.STY) {
    return false;
  }
  if (env.TMUX) {
    return true;
  }
  if (env.TERM_PROGRAM && REFLOWING_PROGRAMS.has(env.TERM_PROGRAM)) {
    return true;
  }
  if (env.KITTY_WINDOW_ID || env.WT_SESSION || env.ALACRITTY_WINDOW_ID || env.VTE_VERSION || env.KONSOLE_VERSION
    || /^xterm-(?:kitty|ghostty)$/.test(env.TERM ?? '')) {
    return true;
  }
  return undefined;
};

/**
 * The real terminal Shelly runs in. Owns raw mode on stdin and is the only
 * place that reads keystrokes, so it can pull terminal replies (cursor
 * position reports) out of the input before anyone else sees them.
 */
export class HostTerminal {
  private inputListener: ((data: string) => void) | undefined;
  private pendingCursorQuery: PendingCursorQuery | undefined;
  /**
   * Replies still owed for settled queries: the plain echo of a DEC answer
   * (at `position`), or both replies of a query that timed out (position
   * unknown). Only replies that cannot be a key are taken out (see dropLateReplies).
   */
  private expectedLateReplies: { count: number; until: number; position: CursorPosition | undefined } = { count: 0, until: 0, position: undefined };
  private started = false;
  /** Input that may be the first part of an owed reply split across reads (over SSH, say). */
  private partialReport: { text: string; timer: NodeJS.Timeout } | undefined;

  constructor(
    private readonly input: NodeJS.ReadStream = process.stdin,
    private readonly output: NodeJS.WriteStream = process.stdout,
  ) {}

  /** Whether the terminal rewraps rows when resized, when its environment tells (see terminalReflows). */
  readonly reflows: boolean | undefined = terminalReflows(process.env);

  get isInteractive(): boolean {
    return Boolean(this.input.isTTY && this.output.isTTY);
  }

  get size(): TerminalSize {
    return { cols: this.output.columns || 80, rows: this.output.rows || 24 };
  }

  /** Enter raw mode and start delivering keystrokes. */
  start(onInput: (data: string) => void): void {
    this.inputListener = onInput;
    this.started = true;
    this.input.setRawMode(true);
    this.input.setEncoding('utf8');
    this.input.on('data', this.handleData);
    this.input.resume();
  }

  /**
   * Leave raw mode and stop reading, and leave the screen usable whatever was
   * drawing on it (a crash mid-frame included): synchronized output ended,
   * attributes reset, cursor shown. Safe to call more than once, and with
   * the output already gone (EPIPE at teardown): raw mode goes first.
   */
  stop(): void {
    this.input.off('data', this.handleData);
    if (this.input.isTTY) {
      try {
        this.input.setRawMode(false);
      } catch {
        // The terminal is gone; there is no mode to restore.
      }
    }
    this.input.pause();
    if (this.started) {
      this.started = false;
      const output = this.output;
      // Writing to a stream that has ended or been destroyed fails later, as an error event.
      if (output.writable && !output.destroyed) {
        try {
          output.write(ansi.endSynchronizedUpdate + ansi.resetStyle + ansi.showCursor);
        } catch {
          // Nothing left to draw on.
        }
      }
    }
    // Nothing is delivered or settled after this: the query in flight fails, and every timer goes.
    this.inputListener = undefined;
    const query = this.pendingCursorQuery;
    if (query) {
      this.pendingCursorQuery = undefined;
      clearTimeout(query.timer);
      if (query.held) {
        clearTimeout(query.held.timer);
      }
      query.reject(new Error('Terminal stopped.'));
    }
    if (this.partialReport) {
      clearTimeout(this.partialReport.timer);
      this.partialReport = undefined;
    }
    this.expectedLateReplies = { count: 0, until: 0, position: undefined };
  }

  onResize(listener: (size: TerminalSize) => void): () => void {
    const handler = (): void => listener(this.size);
    this.output.on('resize', handler);
    return () => this.output.off('resize', handler);
  }

  write(data: string): void {
    if (data) {
      this.output.write(data);
    }
  }

  /**
   * Ask the terminal where the cursor is. Keystrokes that arrive while
   * waiting go on at once; only what may be the reply is held. Callers that
   * ask while a position query is in flight share its answer; one asked
   * while a width query is in flight is sent after it (see ask()).
   */
  queryCursorPosition(timeoutMs = 500): Promise<CursorPosition> {
    if (this.pendingCursorQuery?.kind === 'position') {
      return this.pendingCursorQuery.promise;
    }
    return this.ask('position', '', '', timeoutMs);
  }

  /**
   * The terminal's width as of this point in the output, and the row the
   * cursor is on: the cursor is pushed against the right edge, its position
   * asked for, then sent back to column 1. Everything written before the call
   * was drawn at that width, which tells a view whether its last frame
   * reached the terminal before or after a resize.
   */
  async queryWidth(timeoutMs = 500): Promise<WidthReport> {
    const { row, col } = await this.ask('width', ansi.cursorForward(9999), '\r', timeoutMs);
    return { row, cols: col };
  }

  /**
   * Send one query, after the one in flight (whose answer was asked for at
   * another point in the output). The wait for that one counts towards this
   * one's `timeoutMs`, and if it went unanswered this one fails at once
   * instead of waiting its own time out too: a stalled terminal costs one
   * timeout, not one per query.
   */
  private async ask(kind: PendingCursorQuery['kind'], before: string, after: string, timeoutMs: number): Promise<CursorPosition> {
    const deadline = Date.now() + timeoutMs;
    while (this.pendingCursorQuery) {
      await this.pendingCursorQuery.promise;
    }
    const left = deadline - Date.now();
    if (left <= 0) {
      throw new Error('The terminal did not report its cursor position.');
    }
    let resolve!: (position: CursorPosition) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<CursorPosition>((promiseResolve, promiseReject) => {
      resolve = promiseResolve;
      reject = promiseReject;
    });
    // Callers that share a query may not all wait on it.
    promise.catch(() => undefined);
    const timer = setTimeout(() => {
      this.failPendingQuery(new Error('The terminal did not report its cursor position.'));
    }, left);
    this.pendingCursorQuery = { kind, promise, resolve, reject, timer };
    // Both forms: the DEC answer cannot be mistaken for a key; the plain one works everywhere.
    this.write(before + ansi.requestDecCursorPosition + ansi.requestCursorPosition + after);
    return promise;
  }

  /**
   * Input, with the replies to Shelly's queries taken out. Keystrokes are
   * never held for a reply: while a query waits, only what may be its reply
   * is (a report that could be Shift+F3, briefly; the start of a report cut
   * off at the end of a read, briefly). Typing and Ctrl-C go on at once.
   */
  private readonly handleData = (data: string | Buffer): void => {
    let text = typeof data === 'string' ? data : data.toString('utf8');
    if (this.partialReport) {
      clearTimeout(this.partialReport.timer);
      text = this.partialReport.text + text;
      this.partialReport = undefined;
    }
    // A reply still owed for an earlier query (the plain echo of a DEC answer) comes ahead of a
    // new query's own: taken as that query's answer, it would leave the new query's to reach the shell.
    text = this.dropLateReplies(text);

    for (let query = this.pendingCursorQuery; query; query = this.pendingCursorQuery) {
      const report = extractCursorReport(text);
      if (!report) {
        break;
      }
      if (report.kind === 'plain' && report.ambiguous && !query.held) {
        // Maybe Shift+F3: hold just that and see whether a clearer report follows.
        this.deliver(report.before);
        const held = report.position;
        query.held = {
          text: `\u001b[${held.row};${held.col}R`,
          position: held,
          timer: setTimeout(() => this.settleQuery(held), AMBIGUOUS_REPORT_WAIT_MS),
        };
        text = report.after;
        continue;
      }
      if (query.held) {
        // A held report followed by another one was a key after all.
        clearTimeout(query.held.timer);
        this.deliver(query.held.text);
        query.held = undefined;
      }
      this.deliver(report.before);
      if (report.kind === 'dec') {
        // A terminal that answers the DEC form also answers the plain one, right behind it.
        this.expectLateReplies(1, report.position);
      }
      this.settleQuery(report.position);
      text = this.dropLateReplies(report.after);
    }
    this.passOn(text);
  };

  /** Resolve the pending query with `position`. */
  private settleQuery(position: CursorPosition): void {
    const query = this.pendingCursorQuery;
    if (!query) {
      return;
    }
    clearTimeout(query.timer);
    if (query.held) {
      clearTimeout(query.held.timer);
    }
    this.pendingCursorQuery = undefined;
    query.resolve(position);
  }

  private expectLateReplies(count: number, position?: CursorPosition): void {
    this.expectedLateReplies = { count, until: Date.now() + LATE_REPLY_WINDOW_MS, position };
  }

  /**
   * Take replies owed for settled queries out of `text`. A DEC report is
   * always a reply (no key sends one). A plain report is taken only when it
   * matches the position just answered, or when it could not be a key; one
   * shaped like Shift+F3 (CSI 1;2R) that matches nothing reaches the shell.
   */
  private dropLateReplies(text: string): string {
    const late = this.expectedLateReplies;
    if (late.count === 0 || Date.now() > late.until) {
      this.expectedLateReplies = { count: 0, until: 0, position: undefined };
      return text;
    }
    let rest = text;
    let kept = '';
    while (late.count > 0) {
      const report = extractCursorReport(rest);
      if (!report) {
        break;
      }
      const matches = late.position !== undefined && report.position.row === late.position.row && report.position.col === late.position.col;
      if (report.kind === 'dec' || matches || !report.ambiguous) {
        late.count--;
        if (report.kind === 'dec') {
          late.position = report.position;
        }
        kept += report.before;
      } else {
        kept += report.before + rest.slice(report.before.length, rest.length - report.after.length);
      }
      rest = report.after;
    }
    return kept + rest;
  }

  private lateRepliesOwed(): boolean {
    return this.expectedLateReplies.count > 0 && Date.now() <= this.expectedLateReplies.until;
  }

  /**
   * Pass input on to the listener, without the replies still owed. While
   * a reply is owed or awaited, input that ends in what may be the start of
   * one is held back briefly, so a reply split across two reads is
   * recognised whole instead of reaching the shell in pieces.
   */
  private passOn(input: string): void {
    let text = input;
    if (this.partialReport) {
      clearTimeout(this.partialReport.timer);
      text = this.partialReport.text + text;
      this.partialReport = undefined;
    }
    text = this.dropLateReplies(text);
    const partial = this.lateRepliesOwed() || this.pendingCursorQuery ? PARTIAL_REPORT.exec(text) : null;
    if (partial) {
      const held = text.slice(partial.index);
      text = text.slice(0, partial.index);
      this.partialReport = {
        text: held,
        timer: setTimeout(() => {
          // Nothing followed: it was input after all.
          this.partialReport = undefined;
          this.deliver(this.dropLateReplies(held));
        }, PARTIAL_REPORT_WAIT_MS),
      };
    }
    this.deliver(text);
  }

  private deliver(text: string): void {
    if (text) {
      this.inputListener?.(text);
    }
  }

  private failPendingQuery(error: Error): void {
    const query = this.pendingCursorQuery;
    if (!query) {
      return;
    }

    clearTimeout(query.timer);
    if (query.held) {
      // The only report that came was the ambiguous one: it was the answer.
      this.settleQuery(query.held.position);
      return;
    }
    this.pendingCursorQuery = undefined;
    query.reject(error);
    // A slow terminal (over SSH, say) may still answer: both replies are swallowed if they come soon.
    this.expectLateReplies(2);
  }
}
