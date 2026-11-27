import { ansi } from './ansi.js';
import { dropCursorReports, extractCursorReport, type CursorPosition } from './cursor-report.js';

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

/**
 * The real terminal Shelly runs in. Owns raw mode on stdin and is the only
 * place that reads keystrokes, so it can pull terminal replies (cursor
 * position reports) out of the input before anyone else sees them.
 */
export class HostTerminal {
  private inputListener: ((data: string) => void) | undefined;
  private pendingCursorQuery: PendingCursorQuery | undefined;
  /** Replies still owed for settled queries (the plain echo of a DEC answer, or a late one). */
  private expectedLateReplies = { count: 0, until: 0 };
  private started = false;

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
   * attributes reset, cursor shown. Safe to call more than once.
   */
  stop(): void {
    if (this.started) {
      this.started = false;
      this.write(ansi.endSynchronizedUpdate + ansi.resetStyle + ansi.showCursor);
    }
    this.input.off('data', this.handleData);
    if (this.input.isTTY) {
      this.input.setRawMode(false);
    }
    this.input.pause();
    this.inputListener = undefined;
    this.failPendingQuery(new Error('Terminal stopped.'));
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
    const text = typeof data === 'string' ? data : data.toString('utf8');
    const query = this.pendingCursorQuery;

    if (!query) {
      this.deliver(this.dropLateReplies(text));
      return;
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
        this.expectLateReplies(1);
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
    this.deliver(this.dropLateReplies(query.buffered));
  }

  private expectLateReplies(count: number): void {
    this.expectedLateReplies = { count: this.expectedLateReplies.count + count, until: Date.now() + LATE_REPLY_WINDOW_MS };
  }

  /** Take replies owed for settled queries out of `text`. */
  private dropLateReplies(text: string): string {
    const late = this.expectedLateReplies;
    if (late.count === 0 || Date.now() > late.until) {
      this.expectedLateReplies = { count: 0, until: 0 };
      return text;
    }
    const { text: rest, dropped } = dropCursorReports(text, late.count);
    late.count -= dropped;
    return rest;
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
    this.deliver(query.buffered);
  }
}
