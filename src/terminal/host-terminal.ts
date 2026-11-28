import { ansi } from './ansi.js';
import { extractCursorReport, type CursorPosition } from './cursor-report.js';

export interface TerminalSize {
  readonly cols: number;
  readonly rows: number;
}

interface PendingCursorQuery {
  buffered: string;
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
   * Ask the terminal where the cursor is. Keystrokes that arrive while waiting
   * are delivered as usual once the reply (or the timeout) comes in. Callers
   * that ask while a query is in flight share its answer.
   */
  queryCursorPosition(timeoutMs = 500): Promise<CursorPosition> {
    if (this.pendingCursorQuery) {
      return this.pendingCursorQuery.promise;
    }

    let resolve!: (position: CursorPosition) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<CursorPosition>((promiseResolve, promiseReject) => {
      resolve = promiseResolve;
      reject = promiseReject;
    });
    const timer = setTimeout(() => {
      this.failPendingQuery(new Error('The terminal did not report its cursor position.'));
    }, timeoutMs);
    this.pendingCursorQuery = { buffered: '', promise, resolve, reject, timer };
    // Both forms: the DEC answer cannot be mistaken for a key; the plain one works everywhere.
    this.write(ansi.requestDecCursorPosition + ansi.requestCursorPosition);
    return promise;
  }

  private readonly handleData = (data: string | Buffer): void => {
    let text = typeof data === 'string' ? data : data.toString('utf8');
    const query = this.pendingCursorQuery;

    if (!query) {
      this.passOn(text);
      return;
    }

    if (this.lateRepliesOwed()) {
      // A reply still owed for an earlier query (the plain echo of a DEC
      // answer) comes ahead of this query's own: taken as this query's answer,
      // it would leave this query's replies to reach the shell as typed text.
      if (this.partialReport) {
        clearTimeout(this.partialReport.timer);
        text = this.partialReport.text + text;
        this.partialReport = undefined;
      }
      text = this.dropLateReplies(text);
    }

    query.buffered += text;
    for (;;) {
      const report = extractCursorReport(query.buffered);
      if (!report) {
        return;
      }
      if (report.kind === 'plain' && report.ambiguous && !query.held) {
        // Maybe Shift+F3: hold it and see whether a clearer report follows.
        query.buffered = report.remaining;
        const held = report.position;
        query.held = {
          text: `\u001b[${held.row};${held.col}R`,
          position: held,
          timer: setTimeout(() => this.settleQuery(held), AMBIGUOUS_REPORT_WAIT_MS),
        };
        continue;
      }
      // A held report followed by another one was a key after all.
      query.buffered = (query.held?.text ?? '') + report.before + report.after;
      if (report.kind === 'dec') {
        // A terminal that answers the DEC form also answers the plain one, right behind it.
        this.expectLateReplies(1, report.position);
      }
      this.settleQuery(report.position);
      return;
    }
  };

  /** Resolve the pending query with `position` and pass on the keystrokes that came with it. */
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
    this.passOn(query.buffered);
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
   * replies are owed, input that ends in what may be the start of one is
   * held back briefly, so a reply split across two reads is recognised
   * whole instead of reaching the shell in pieces.
   */
  private passOn(input: string): void {
    let text = input;
    if (this.partialReport) {
      clearTimeout(this.partialReport.timer);
      text = this.partialReport.text + text;
      this.partialReport = undefined;
    }
    text = this.dropLateReplies(text);
    const partial = this.lateRepliesOwed() ? PARTIAL_REPORT.exec(text) : null;
    if (partial) {
      const held = text.slice(partial.index);
      text = text.slice(0, partial.index);
      this.partialReport = {
        text: held,
        timer: setTimeout(() => {
          // Nothing followed: it was input after all.
          this.partialReport = undefined;
          this.deliver(held);
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
    this.passOn(query.buffered);
  }
}
