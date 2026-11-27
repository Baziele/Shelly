import type { CommandRegistry } from '../commands/slash-commands.js';
import { InlinePainter, type PaintFrame } from '../render/inline-painter.js';
import type { ColorDepth } from '../render/sgr.js';
import { ansi } from '../terminal/ansi.js';
import type { CursorPosition } from '../terminal/cursor-report.js';
import type { HostTerminal } from '../terminal/host-terminal.js';
import { HeadlessRenderer } from './headless-renderer.js';
import type { PickerItem } from './list-picker.js';
import { MAX_VIEW_ROWS, PromptView, type PickerRequest, type PromptMode } from './prompt-view.js';

/** Below this many free columns after the prompt, the input moves to its own row. */
const MIN_INLINE_INPUT_COLS = 24;

export interface OverlayOpenOptions {
  /** Defaults from the trigger: `__` is fast mode. */
  readonly mode?: PromptMode;
  /** Fast mode from a half-typed command: the command being rewritten. */
  readonly rewriting?: string;
  /** Right-aligned on the input row: where `::` will go. */
  readonly hint?: string;
}

export interface InlineOverlayHandlers {
  readonly onSubmit: (text: string) => void;
  readonly onCancel: () => void;
}

interface OverlaySession {
  /** Where the shell left the cursor; it goes back here when the overlay closes. */
  origin: CursorPosition;
  /** Top-left cell of the painted region. */
  anchor: CursorPosition;
  /** The cursor as last painted, in frame coordinates. */
  lastCursor: PaintFrame['cursor'] | undefined;
}

/**
 * Shelly's input UI, drawn in place on the main screen right after the shell
 * prompt. The prompt and scrollback stay where they are; the overlay only
 * owns the cells from the prompt's end onward and the rows below it.
 */
export class InlineOverlay {
  private readonly headless: HeadlessRenderer;
  private readonly view: PromptView;
  private readonly painter: InlinePainter;
  private session: OverlaySession | undefined;

  constructor(
    private readonly host: HostTerminal,
    commands: CommandRegistry,
    colorDepth: ColorDepth,
    handlers: InlineOverlayHandlers,
  ) {
    this.headless = HeadlessRenderer.create({ width: host.size.cols, height: MAX_VIEW_ROWS });
    this.painter = new InlinePainter(colorDepth);
    // Key handlers fire mid-dispatch inside OpenTUI; let it finish before the overlay is torn down.
    this.view = new PromptView(this.headless.renderer, commands, {
      onSubmit: (text) => queueMicrotask(() => handlers.onSubmit(text)),
      onCancel: () => queueMicrotask(() => handlers.onCancel()),
    });
    this.headless.onFrame((frame) => this.paint(frame));
  }

  get isOpen(): boolean {
    return this.session !== undefined;
  }

  /**
   * Take over the input line at `cursor` (the end of the shell prompt).
   * `initialInput` is anything typed after the trigger before the overlay was ready.
   */
  open(cursor: CursorPosition, trigger: string, initialInput: string, options: OverlayOpenOptions = {}): void {
    const { cols } = this.host.size;
    const fitsInline = cols - cursor.col + 1 >= MIN_INLINE_INPUT_COLS;
    const anchor = fitsInline ? { ...cursor } : { row: cursor.row + 1, col: 1 };

    this.session = { origin: { ...cursor }, anchor, lastCursor: undefined };
    this.headless.resize({ width: cols, height: MAX_VIEW_ROWS });
    this.painter.invalidate();
    this.view.open({ inputCol: anchor.col, trigger, ...options });
    if (initialInput) {
      this.headless.feed(initialInput);
    }
    this.headless.requestRender();
  }

  /** Where `::` will go, shown right-aligned on the input row. */
  setHint(hint: string | undefined): void {
    this.update(() => this.view.setHint(hint));
  }

  /** Fast mode: the request is running (spinner, typing paused) or not. */
  setBusy(busy: boolean): void {
    this.update(() => this.view.setBusy(busy));
  }

  /** Fast mode: the reply so far. */
  setPreview(text: string): void {
    this.update(() => this.view.setPreview(text));
  }

  /** Fast mode: the request failed; the input stays open to retry. */
  setError(message: string): void {
    this.update(() => this.view.setError(message));
  }

  /** A list to pick from (/threads, /agent, /mode); the input filters it. */
  openPicker(request: PickerRequest): void {
    this.update(() => this.view.openPicker({
      ...request,
      // Picking or closing happens mid-dispatch inside OpenTUI, like submit.
      onPick: (item: PickerItem) => queueMicrotask(() => request.onPick(item)),
      onClose: () => queueMicrotask(() => request.onClose()),
    }));
  }

  closePicker(): void {
    this.update(() => this.view.closePicker());
  }

  private update(change: () => void): void {
    if (!this.session) {
      return;
    }
    change();
    this.headless.requestRender();
  }

  /** Raw keystrokes from the user. */
  feed(data: string): void {
    if (this.session) {
      this.headless.feed(data);
    }
  }

  /** Erase the overlay and return the cursor to where the shell left it. */
  close(): void {
    const session = this.session;
    if (!session) {
      return;
    }

    this.session = undefined;
    this.view.close();
    this.host.write(this.painter.erase(session.anchor) + ansi.cursorTo(session.origin.row, session.origin.col));
  }

  /**
   * Re-anchor after the terminal was resized. `cursor` is where the terminal
   * now reports the cursor, which was sitting in the overlay's input.
   */
  relayout(cursor: CursorPosition): void {
    const session = this.session;
    if (!session) {
      return;
    }

    const last = session.lastCursor ?? { row: 1, col: session.anchor.col };
    const rowShift = cursor.row - (session.anchor.row + last.row - 1);
    const colShift = cursor.col - last.col;
    session.anchor = { row: session.anchor.row + rowShift, col: Math.max(1, session.anchor.col + colShift) };
    session.origin = { row: session.origin.row + rowShift, col: Math.max(1, session.origin.col + colShift) };

    this.host.write(this.painter.erase(session.anchor));
    this.headless.resize({ width: this.host.size.cols, height: MAX_VIEW_ROWS });
    this.headless.requestRender();
  }

  destroy(): void {
    this.session = undefined;
    this.view.destroy();
    this.headless.destroy();
  }

  private paint(frame: PaintFrame): void {
    const session = this.session;
    if (!session) {
      return;
    }

    const rows = frame.rows.slice(0, this.view.height);
    this.makeRoom(session, rows.length);
    session.lastCursor = frame.cursor;
    this.host.write(this.painter.paint({ rows, cursor: frame.cursor }, session.anchor));
  }

  /** Scroll the screen up when the overlay would run past the bottom row. */
  private makeRoom(session: OverlaySession, rowCount: number): void {
    const { rows } = this.host.size;
    const overflow = session.anchor.row + rowCount - 1 - rows;
    if (overflow <= 0) {
      return;
    }

    this.host.write(ansi.resetStyle + ansi.cursorTo(rows, 1) + '\n'.repeat(overflow));
    session.anchor = { ...session.anchor, row: session.anchor.row - overflow };
    session.origin = { ...session.origin, row: session.origin.row - overflow };
  }
}
