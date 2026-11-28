import { ansi } from './ansi.js';
import { extractCursorReport, type CursorPosition } from './cursor-report.js';

export interface TerminalSize {
  readonly cols: number;
  readonly rows: number;
}

interface PendingCursorQuery {
  readonly promise: Promise<CursorPosition>;
  readonly resolve: (position: CursorPosition) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
  /**
   * A plain report that may be Shift+F3 and friends, waiting to see whether
   * a real one follows; input that comes meanwhile waits behind it (`after`),
   * so keys keep their order.
   */
  held?: { readonly text: string; readonly position: CursorPosition; readonly timer: NodeJS.Timeout; after: string };
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
    // Keys typed behind a possible Shift+F3 still go on (the held report itself, likely a late reply, does not).
    const heldKeys = this.pendingCursorQuery?.held?.after;
    if (heldKeys) {
      this.deliver(heldKeys);
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
   * ask while a query is in flight share its answer, so a stalled terminal
   * costs one timeout, not one per caller.
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
    // Callers that share a query may not all wait on it.
    promise.catch(() => undefined);
    const timer = setTimeout(() => {
      this.failPendingQuery(new Error('The terminal did not report its cursor position.'));
    }, timeoutMs);
    this.pendingCursorQuery = { promise, resolve, reject, timer };
    // Both forms: the DEC answer cannot be mistaken for a key; the plain one works everywhere.
    this.write(ansi.requestDecCursorPosition + ansi.requestCursorPosition);
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
        // Maybe Shift+F3: hold it (and what follows, to keep keys in order) and see whether a clearer
        // report follows.
        this.deliver(report.before);
        const held = report.position;
        query.held = {
          text: `\u001b[${held.row};${held.col}R`,
          position: held,
          timer: setTimeout(() => this.settleQuery(held), AMBIGUOUS_REPORT_WAIT_MS),
          after: '',
        };
        text = report.after;
        continue;
      }
      if (query.held) {
        // A held report followed by another one was a key after all: it goes on, in order.
        clearTimeout(query.held.timer);
        this.deliver(query.held.text + query.held.after);
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
    this.deliverOrHold(text);
  };

  /** Resolve the pending query with `position`. */
  private settleQuery(position: CursorPosition): void {
    const query = this.pendingCursorQuery;
    if (!query) {
      return;
    }
    clearTimeout(query.timer);
    const after = query.held?.after ?? '';
    if (query.held) {
      clearTimeout(query.held.timer);
    }
    this.pendingCursorQuery = undefined;
    query.resolve(position);
    // Input that waited behind a held report that turned out to be the answer.
    if (after) {
      this.deliverOrHold(after);
    }
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
   * Where input goes once the replies in it are taken out. One path for all
   * of it, so keys keep their order:
   * - the start of a reply cut off at the end of a read (while a reply is
   *   owed or awaited) waits briefly for the rest, then goes on as input if
   *   nothing follows;
   * - while a report that may be Shift+F3 is held, everything else waits
   *   behind it (see settleQuery, stop);
   * - otherwise it goes on at once.
   */
  private deliverOrHold(input: string, mayBeCut = true): void {
    let text = input;
    const partial = mayBeCut && (this.lateRepliesOwed() || this.pendingCursorQuery) ? PARTIAL_REPORT.exec(text) : null;
    if (partial) {
      const start = text.slice(partial.index);
      text = text.slice(0, partial.index);
      this.partialReport = {
        text: start,
        timer: setTimeout(() => {
          // Nothing followed: it was input after all.
          this.partialReport = undefined;
          this.deliverOrHold(this.dropLateReplies(start), false);
        }, PARTIAL_REPORT_WAIT_MS),
      };
    }
    const held = this.pendingCursorQuery?.held;
    if (held) {
      held.after += text;
      return;
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
