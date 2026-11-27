import { ansi } from './ansi.js';
import { extractCursorReport, type CursorPosition } from './cursor-report.js';

export interface TerminalSize {
  readonly cols: number;
  readonly rows: number;
}

interface PendingCursorQuery {
  buffered: string;
  readonly resolve: (position: CursorPosition) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

/**
 * The real terminal Shelly runs in. Owns raw mode on stdin and is the only
 * place that reads keystrokes, so it can pull terminal replies (cursor
 * position reports) out of the input before anyone else sees them.
 */
export class HostTerminal {
  private inputListener: ((data: string) => void) | undefined;
  private pendingCursorQuery: PendingCursorQuery | undefined;

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
    this.input.setRawMode(true);
    this.input.setEncoding('utf8');
    this.input.on('data', this.handleData);
    this.input.resume();
  }

  /** Leave raw mode and stop reading. Safe to call more than once. */
  stop(): void {
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
   * are delivered as usual once the reply (or the timeout) comes in.
   */
  queryCursorPosition(timeoutMs = 500): Promise<CursorPosition> {
    if (this.pendingCursorQuery) {
      return Promise.reject(new Error('A cursor position query is already in flight.'));
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.failPendingQuery(new Error('The terminal did not report its cursor position.'));
      }, timeoutMs);
      this.pendingCursorQuery = { buffered: '', resolve, reject, timer };
      this.write(ansi.requestCursorPosition);
    });
  }

  private readonly handleData = (data: string | Buffer): void => {
    const text = typeof data === 'string' ? data : data.toString('utf8');
    const query = this.pendingCursorQuery;

    if (!query) {
      this.inputListener?.(text);
      return;
    }

    query.buffered += text;
    const report = extractCursorReport(query.buffered);
    if (!report) {
      return;
    }

    clearTimeout(query.timer);
    this.pendingCursorQuery = undefined;
    query.resolve(report.position);
    if (report.remaining) {
      this.inputListener?.(report.remaining);
    }
  };

  private failPendingQuery(error: Error): void {
    const query = this.pendingCursorQuery;
    if (!query) {
      return;
    }

    clearTimeout(query.timer);
    this.pendingCursorQuery = undefined;
    query.reject(error);
    if (query.buffered) {
      this.inputListener?.(query.buffered);
    }
  }
}
