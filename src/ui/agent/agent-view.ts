import { BoxRenderable, TextRenderable, type SyntaxStyle } from '@opentui/core';
import type { ThreadEvent } from '../../protocol/schema.js';
import type { PaintFrame } from '../../render/inline-painter.js';
import { LiveRegion, type LiveRegionScreen, type PaintRow } from '../../render/live-region.js';
import type { ColorDepth } from '../../render/sgr.js';
import type { CursorPosition } from '../../terminal/cursor-report.js';
import { HeadlessRenderer } from '../headless-renderer.js';
import {
  SPINNER_INTERVAL_MS,
  formatBackgrounded,
  formatModeChange,
  formatNotice,
  formatPermission,
  formatPermissionOutcome,
  formatPlan,
  formatStatus,
  formatSummary,
  formatThought,
  formatTool,
  shortToolTitle,
  spinnerFrame,
  UNKNOWN_AGENT,
  type FormatContext,
} from './format.js';
import { parseKeys, PasteFilter, type Key } from './keys.js';
import { fitLine, oneLine, seg, type Line } from './lines.js';
import { createMarkdownStyle, MessageView, type StableSplit } from './message-view.js';
import { lineToPaintRow } from './paint-line.js';
import { toStyledText } from './styled.js';
import { hasGapBefore, TurnModel, type Block, type LineBlock, type Phase, type PermissionRequest } from './turn-model.js';

/** The host terminal as the agent view uses it: its size, and output. It is never asked anything. */
export type AgentViewHost = LiveRegionScreen;

export interface AgentViewOptions {
  /** Shown in the status line and prompts: `claude`. */
  readonly agentName: string;
  /** The shell's working directory; paths are shown relative to it. */
  readonly cwd: string;
  readonly home: string;
  /** Rows kept free above the live region. */
  readonly marginRows?: number;
  readonly now?: () => number;
  /** Timers for the spinner, the Esc hold and the resize fallback; tests pass fake ones. */
  readonly timers?: Partial<ViewTimers>;
}

export interface ViewTimers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

const REAL_TIMERS: ViewTimers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
  setInterval: (callback, ms) => setInterval(callback, ms),
  clearInterval: (handle) => clearInterval(handle as NodeJS.Timeout),
};

export type AgentAction =
  | { readonly type: 'answer'; readonly requestId: string; readonly optionId: string | null }
  | { readonly type: 'cancel' }
  | { readonly type: 'background' };

/** Frames are coalesced to at most one per this many milliseconds (about 60 fps). */
const FRAME_MS = 16;
/** Keys are ignored this long after a permission prompt appears, so a keystroke meant for something else cannot answer it. */
const PROMPT_ARM_MS = 300;
/** A lone ESC waits this long for the rest of an escape sequence split across reads. */
const ESCAPE_WAIT_MS = 40;
/** While the user is being asked, the status line (and its elapsed time) redraws once a second. */
const WAITING_REDRAW_MS = 1000;
/** A resize nobody passed on to relayout() is handled after the size has held still this long. */
const AUTO_RELAYOUT_MS = 150;
/** Longest finish() waits for the last frames before giving the terminal back anyway. */
const FINISH_TIMEOUT_MS = 2000;

type State = 'created' | 'running' | 'finishing' | 'done';

interface BlockViewBase {
  readonly key: string;
  readonly root: BoxRenderable;
  /** What the last sync showed: commits go by what was drawn, not by the model. */
  syncedFinal: boolean;
  syncedVersion: number;
  syncedWidth: number;
  syncedSpinner: string;
}

interface MessageBlockView extends BlockViewBase {
  readonly kind: 'message';
  readonly message: MessageView;
}

interface TextBlockView extends BlockViewBase {
  readonly kind: 'text';
  readonly text: TextRenderable;
}

type BlockView = MessageBlockView | TextBlockView;

/** The layout of one frame, read while OpenTUI hands the frame over. */
interface FrameSnapshot {
  readonly rows: PaintFrame['rows'];
  /** Cells across the frame: the width OpenTUI actually drew at. */
  readonly width: number;
  readonly height: number;
  readonly blocks: ReadonlyArray<{ readonly key: string; readonly bottom: number; readonly final: boolean; readonly split: StableSplit | undefined; readonly top: number }>;
}

/**
 * A running agent turn, drawn inline below the user's echoed request.
 * Finished output goes to scrollback in order; running tool calls, the
 * streaming paragraph, the plan, permission prompts and the status line stay
 * in a live region at the bottom that repaints in place.
 */
export class AgentView {
  private readonly model = new TurnModel();
  private readonly headless: HeadlessRenderer;
  private readonly region: LiveRegion;
  private readonly style: SyntaxStyle;
  private readonly root: BoxRenderable;
  private readonly blocksBox: BoxRenderable;
  private readonly extras: TextRenderable;
  private readonly views = new Map<string, BlockView>();
  private readonly listeners = new Set<(action: AgentAction) => void>();
  private readonly now: () => number;
  /** The agent's name as shown: it comes from config or the daemon, so it is sanitized. */
  private agentName: string;

  private state: State = 'created';
  /** Runs once start() has: what a finish() waiting for it to begin needs. */
  private onStart: (() => void) | undefined;
  private startedAt = 0;
  private bufferRows: number;
  private frameTimer: NodeJS.Timeout | undefined;
  private spinnerTimer: unknown;
  private readonly timers: ViewTimers;
  private autoRelayout: { timer: unknown; cols: number; rows: number } | undefined;
  private lastTickAt = 0;
  /** A frame was requested and has not been processed yet. */
  private awaitingFrame = false;
  /** Something changed while a frame was in flight. */
  private dirty = false;
  private selectedOption = 0;
  private shownRequestId: string | undefined;
  /** When the prompt on screen first showed; keys before PROMPT_ARM_MS after it are ignored. */
  private promptShownAt = 0;
  private readonly pastes: PasteFilter;
  private pendingEscape: unknown;
  /** The terminal size the live region was last laid out for; painting waits for relayout() after a resize. */
  private laidOutSize: { cols: number; rows: number };
  private lastSpinnerFrameAt = 0;
  private tickStartedAt = 0;
  private idleWaiters: Array<() => void> = [];
  private stats = { frames: 0, renderMs: 0, firstPaintMs: -1 };
  private released = false;

  constructor(
    private readonly host: AgentViewHost,
    private readonly colorDepth: ColorDepth,
    private readonly options: AgentViewOptions,
  ) {
    this.now = options.now ?? Date.now;
    // Methods are taken one by one (and bound): a timers object may be a class instance.
    const timers = options.timers;
    this.timers = {
      setTimeout: timers?.setTimeout?.bind(timers) ?? REAL_TIMERS.setTimeout,
      clearTimeout: timers?.clearTimeout?.bind(timers) ?? REAL_TIMERS.clearTimeout,
      setInterval: timers?.setInterval?.bind(timers) ?? REAL_TIMERS.setInterval,
      clearInterval: timers?.clearInterval?.bind(timers) ?? REAL_TIMERS.clearInterval,
    };
    this.pastes = new PasteFilter(this.now);
    this.agentName = oneLine(options.agentName) || UNKNOWN_AGENT;
    this.bufferRows = this.baseBufferRows();
    this.laidOutSize = { ...host.size };
    this.headless = HeadlessRenderer.create({ width: host.size.cols, height: this.bufferRows });
    this.region = new LiveRegion(host, colorDepth, { marginRows: options.marginRows ?? 2 });
    this.style = createMarkdownStyle(this.headless.renderer);

    const renderer = this.headless.renderer;
    this.root = new BoxRenderable(renderer, { flexDirection: 'column', width: '100%', flexShrink: 0 });
    this.blocksBox = new BoxRenderable(renderer, { flexDirection: 'column', width: '100%', flexShrink: 0 });
    this.extras = new TextRenderable(renderer, { content: '', wrapMode: 'none', width: '100%', flexShrink: 0 });
    this.root.add(this.blocksBox);
    this.root.add(this.extras);
    renderer.root.add(this.root);
    this.headless.onFrame((frame) => this.captureFrame(frame));
  }

  /** Begin drawing at `anchor`: the row below the echoed request (or the cursor at the end of it). */
  start(anchor: CursorPosition): void {
    if (this.state !== 'created') {
      return;
    }
    this.state = 'running';
    this.startedAt = this.now();
    this.region.start(anchor);
    this.spinnerTimer = this.timers.setInterval(() => this.spin(), SPINNER_INTERVAL_MS);
    this.schedule();
    this.onStart?.();
  }

  apply(event: ThreadEvent): void {
    if (this.state === 'done') {
      return;
    }
    this.model.apply(event);
    if (event.type === 'turn.ended') {
      this.timers.clearInterval(this.spinnerTimer);
    }
    this.schedule();
  }

  /** The agent turned out to be another than the view was made for (it was not known yet). */
  setAgentName(name: string): void {
    this.agentName = oneLine(name) || UNKNOWN_AGENT;
    this.schedule();
  }

  /**
   * Keys typed while the turn runs. Returns whether the view used them; the
   * caller passes on whatever it did not use (to the shell, after the turn).
   *
   * - Ctrl-C typed anywhere in a read stops the turn, prompt open or not (a
   *   0x03 inside a bracketed paste is pasted text, not a keystroke).
   * - Pasted text (bracketed paste, followed across reads) is never a key:
   *   it is handed back, so a paste meant for the shell is not lost.
   * - Only a read that is exactly one key is a keystroke for the view. A
   *   burst (typed ahead, or bunched up over a slow link) is handed back, so
   *   "git status⏎" typed ahead cannot answer a prompt.
   * - While a prompt is open, a single key belongs to it, and is ignored for
   *   its first moments on screen.
   */
  handleInput(data: string): boolean {
    if (this.state !== 'running' || this.model.ended) {
      return false;
    }
    if (this.pendingEscape) {
      this.timers.clearTimeout(this.pendingEscape);
      this.pendingEscape = undefined;
      data = `\u001b${data}`;
    }
    const { text, pasted } = this.pastes.filter(data);
    // A Ctrl-C typed outside a paste (a 0x03 inside one is pasted text, not a keystroke).
    if (text.includes('\u0003')) {
      this.stop();
      return true;
    }
    if (pasted) {
      return false;
    }
    if (text === '\u001b') {
      // Maybe the start of an escape sequence split across reads: wait for the rest.
      this.pendingEscape = this.timers.setTimeout(() => {
        this.pendingEscape = undefined;
        this.handleKey({ name: 'escape' });
      }, ESCAPE_WAIT_MS);
      return true;
    }
    const keys = parseKeys(text);
    if (keys.length !== 1) {
      return false;
    }
    return this.handleKey(keys[0]!);
  }

  private handleKey(key: Key): boolean {
    if (this.state !== 'running' || this.model.ended) {
      return false;
    }
    if (key.name === 'ctrl-c') {
      this.stop();
      return true;
    }
    const request = this.model.permissions[0];
    if (request) {
      // Not on screen yet, or only just: the key was meant for something else.
      if (this.promptState === 'ready') {
        this.handlePermissionKey(request, key);
      }
      return true;
    }
    if (key.name === 'escape') {
      this.background();
      return true;
    }
    return false;
  }

  /**
   * `ready` when a permission prompt is on screen and past its arming delay,
   * so a key would answer it; `arming` while it is not drawn yet or only
   * just; `none` with no prompt open.
   */
  get promptState(): 'none' | 'arming' | 'ready' {
    const request = this.model.permissions[0];
    if (!request) {
      return 'none';
    }
    return this.shownRequestId === request.requestId && this.now() - this.promptShownAt >= PROMPT_ARM_MS ? 'ready' : 'arming';
  }

  onAction(listener: (action: AgentAction) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Commit what is left, erase the live region and leave the cursor on a
   * fresh line below everything, ready for the shell prompt.
   */
  async finish(): Promise<void> {
    if (this.state === 'created') {
      // The turn can end before the view knows where to draw (the terminal
      // has not said where the cursor is yet): wait for that, or a turn that
      // ends quickly would show nothing at all.
      await Promise.race([
        new Promise<void>((resolve) => (this.onStart = resolve)),
        new Promise<void>((resolve) => setTimeout(resolve, FINISH_TIMEOUT_MS).unref()),
      ]);
      this.onStart = undefined;
      if ((this.state as State) === 'created') {
        this.state = 'done';
        return;
      }
    }
    if (this.state !== 'running') {
      return;
    }
    if (this.awaitingRelayout()) {
      // A resize nobody relaid out for: do it now, or the last output would never be painted.
      await this.relayout();
      // destroy() (or another finish()) may have run while the terminal answered.
      if ((this.state as State) !== 'running') {
        return;
      }
    }
    this.state = 'finishing';
    this.timers.clearInterval(this.spinnerTimer);
    if (!this.model.ended) {
      // No turn.ended (the connection dropped, say): what is on screen goes to scrollback as it stands.
      this.model.settle();
      this.schedule();
    }
    await Promise.race([
      this.whenIdle(),
      new Promise<void>((resolve) => setTimeout(resolve, FINISH_TIMEOUT_MS).unref()),
    ]);
    // destroy() during the wait has already given the terminal back.
    if ((this.state as State) !== 'finishing') {
      return;
    }
    this.close();
  }

  /**
   * Repaint at the new size after the terminal was resized. Call once the
   * size has settled. It clears the rows the live region certainly owns and
   * draws them again at the new width; it asks the terminal nothing, so it
   * never waits on it (see LiveRegion.relayout).
   */
  async relayout(): Promise<void> {
    if (this.state !== 'running' && this.state !== 'finishing') {
      return;
    }
    this.cancelAutoRelayout();
    this.region.relayout();
    this.laidOutSize = { ...this.host.size };
    this.headless.resize({ width: this.host.size.cols, height: this.bufferRows });
    this.schedule();
  }

  /** Stop at once and free the renderer, without committing anything more. */
  destroy(): void {
    if (this.state === 'running' || this.state === 'finishing') {
      // Torn down mid-turn (an error, the shell exiting): no live rows or hidden cursor left behind.
      if (this.awaitingRelayout()) {
        this.region.relayout();
      }
      this.region.finish();
    }
    this.cancelAutoRelayout();
    this.state = 'done';
    this.timers.clearTimeout(this.pendingEscape);
    clearTimeout(this.frameTimer);
    this.timers.clearInterval(this.spinnerTimer);
    this.releaseIdleWaiters();
    this.releaseRenderer();
  }

  /** Rows in the live region now: what a resize can disturb. */
  get liveRowCount(): number {
    return this.region.liveRowCount;
  }

  /** Rendering costs so far, for measurements. */
  /** `averageFrameMs` counts OpenTUI's layout and drawing as well as Shelly's commit and paint. */
  get renderStats(): { readonly frames: number; readonly averageFrameMs: number; readonly firstPaintMs: number } {
    return {
      frames: this.stats.frames,
      averageFrameMs: this.stats.frames ? this.stats.renderMs / this.stats.frames : 0,
      firstPaintMs: this.stats.firstPaintMs,
    };
  }

  private spin(): void {
    if (this.awaitingRelayout()) {
      this.armAutoRelayout();
      return;
    }
    // A prompt waits on a person: redraw for the elapsed time once a second, not every spinner frame.
    if (this.model.permissions.length > 0 && this.now() - this.lastSpinnerFrameAt < WAITING_REDRAW_MS) {
      return;
    }
    this.lastSpinnerFrameAt = this.now();
    this.schedule();
  }

  private baseBufferRows(): number {
    return Math.max(48, this.host.size.rows * 2);
  }

  /**
   * A resize that relayout() was never called for would freeze the view:
   * once the new size has held for AUTO_RELAYOUT_MS, relay out anyway.
   */
  private armAutoRelayout(): void {
    const { cols, rows } = this.host.size;
    if (this.autoRelayout && this.autoRelayout.cols === cols && this.autoRelayout.rows === rows) {
      return;
    }
    this.cancelAutoRelayout();
    this.autoRelayout = {
      cols,
      rows,
      timer: this.timers.setTimeout(() => {
        this.autoRelayout = undefined;
        if (!this.awaitingRelayout()) {
          return;
        }
        const size = this.host.size;
        if (size.cols !== cols || size.rows !== rows) {
          this.armAutoRelayout();
          return;
        }
        void this.relayout();
      }, AUTO_RELAYOUT_MS),
    };
  }

  private cancelAutoRelayout(): void {
    if (this.autoRelayout) {
      this.timers.clearTimeout(this.autoRelayout.timer);
      this.autoRelayout = undefined;
    }
  }

  /** The terminal was resized and relayout() has not run yet: painting now would land on reflowed scrollback. */
  private awaitingRelayout(): boolean {
    const { cols, rows } = this.host.size;
    return cols !== this.laidOutSize.cols || rows !== this.laidOutSize.rows;
  }

  // ─── Input ────────────────────────────────────────────────────────────────

  private handlePermissionKey(request: PermissionRequest, key: Key): void {
    const count = request.options.length;
    const move = (step: number): void => {
      if (count > 0) {
        this.selectedOption = (this.selectedOption + step + count) % count;
        this.schedule();
      }
    };
    switch (key.name) {
      case 'left':
      case 'up':
      case 'shift-tab':
        move(-1);
        return;
      case 'right':
      case 'down':
      case 'tab':
        move(1);
        return;
      case 'enter':
        this.answer(request, request.options[this.selectedOption]?.optionId ?? null);
        return;
      case 'escape':
        this.answer(request, firstOption(request, 'reject')?.optionId ?? null);
        return;
      case 'char': {
        const char = key.char.toLowerCase();
        if (/^[1-9]$/.test(char)) {
          const option = request.options[Number(char) - 1];
          if (option) {
            this.answer(request, option.optionId);
          }
        } else if (char === 'y') {
          const option = firstOption(request, 'allow');
          if (option) {
            this.answer(request, option.optionId);
          }
        } else if (char === 'n') {
          this.answer(request, firstOption(request, 'reject')?.optionId ?? null);
        }
        return;
      }
      default:
        return;
    }
  }

  private answer(request: PermissionRequest, optionId: string | null): void {
    this.model.answer(request.requestId, optionId);
    this.emit({ type: 'answer', requestId: request.requestId, optionId });
    this.schedule();
  }

  private stop(): void {
    this.model.stopping = true;
    this.emit({ type: 'cancel' });
    this.schedule();
  }

  /** Hand the terminal back while the agent keeps working. */
  private background(): void {
    this.emit({ type: 'background' });
    this.state = 'finishing';
    this.timers.clearInterval(this.spinnerTimer);
    clearTimeout(this.frameTimer);
    const row = lineToPaintRow(formatBackgrounded(this.formatContext()));
    this.region.update([row], []);
    this.close();
  }

  private emit(action: AgentAction): void {
    for (const listener of this.listeners) {
      listener(action);
    }
  }

  // ─── Frames ───────────────────────────────────────────────────────────────

  private schedule(): void {
    if (this.state === 'created' || this.state === 'done') {
      return;
    }
    if (this.awaitingFrame) {
      this.dirty = true;
      return;
    }
    if (this.frameTimer) {
      return;
    }
    const wait = Math.max(0, FRAME_MS - (this.now() - this.lastTickAt));
    this.frameTimer = setTimeout(() => {
      this.frameTimer = undefined;
      this.tick();
    }, wait);
  }

  private tick(): void {
    if (this.state === 'created' || this.state === 'done') {
      return;
    }
    if (this.awaitingFrame || this.awaitingRelayout()) {
      if (this.awaitingRelayout()) {
        this.armAutoRelayout();
      }
      this.dirty = true;
      return;
    }
    this.lastTickAt = this.now();
    this.tickStartedAt = performance.now();
    this.dirty = false;
    this.sync();
    this.awaitingFrame = true;
    this.headless.requestRender();
  }

  /** Bring the OpenTUI tree up to date with the model. */
  private sync(): void {
    const context = this.formatContext();
    const { blocks, committed } = this.model;
    const liveKeys = new Set<string>();

    for (let index = committed; index < blocks.length; index++) {
      const block = blocks[index]!;
      liveKeys.add(block.key);
      let view = this.views.get(block.key);
      if (!view) {
        view = this.createView(block);
        this.views.set(block.key, view);
      }
      // Blocks can be inserted mid-list (a permission outcome above its tool); keep the tree in order.
      const position = index - committed;
      if (this.blocksBox.getChildren()[position] !== view.root) {
        this.blocksBox.add(view.root, position);
      }
      this.updateView(view, block, blocks[index - 1], context);
    }

    for (const [key, view] of this.views) {
      if (!liveKeys.has(key)) {
        this.destroyView(key, view);
      }
    }

    this.extras.content = toStyledText(this.extraLines(context));
  }

  private createView(block: Block): BlockView {
    const renderer = this.headless.renderer;
    const base = { key: block.key, syncedFinal: false, syncedVersion: -1, syncedWidth: -1, syncedSpinner: '' };
    if (block.kind === 'message') {
      const message = new MessageView(renderer, this.style, { codeMarks: this.colorDepth === 'none' });
      return { ...base, kind: 'message', root: message.root, message };
    }
    const root = new BoxRenderable(renderer, { flexDirection: 'column', width: '100%', flexShrink: 0 });
    const text = new TextRenderable(renderer, { content: '', wrapMode: 'none', width: '100%', flexShrink: 0 });
    root.add(text);
    return { ...base, kind: 'text', root, text };
  }

  private updateView(view: BlockView, block: Block, previous: Block | undefined, context: FormatContext): void {
    const gap = hasGapBefore(previous, block);
    if (view.kind === 'message' && block.kind === 'message') {
      view.message.gapBefore = gap;
      if (view.syncedVersion !== block.version) {
        view.message.update(block.text, block.final);
      }
    } else if (view.kind === 'text') {
      view.root.marginTop = gap ? 1 : 0;
      const animated = block.kind === 'tool' && block.tool.status === 'in_progress' && !block.stopped;
      const spinnerChanged = animated && view.syncedSpinner !== context.spinner;
      if (view.syncedVersion !== block.version || view.syncedWidth !== context.width || spinnerChanged) {
        view.text.content = toStyledText(this.blockLines(block, context));
      }
    }
    view.syncedFinal = block.final;
    view.syncedVersion = block.version;
    view.syncedWidth = context.width;
    view.syncedSpinner = context.spinner;
  }

  private destroyView(key: string, view: BlockView): void {
    this.views.delete(key);
    if (view.kind === 'message') {
      view.message.destroy();
    } else {
      view.root.destroyRecursively();
    }
  }

  private captureFrame(frame: PaintFrame): void {
    if (!this.awaitingFrame) {
      // OpenTUI drew on its own; nothing changed that was not painted already.
      return;
    }
    const top = this.root.y;
    const blocks = this.model.blocks.slice(this.model.committed).flatMap((block) => {
      const view = this.views.get(block.key);
      if (!view) {
        return [];
      }
      return [{
        key: block.key,
        top: view.root.y - top,
        bottom: view.root.y + view.root.height - top,
        final: view.syncedFinal,
        split: view.kind === 'message' && !view.syncedFinal ? messageSplit(view.message, frame.rows, view.message.markdown.y - top) : undefined,
      }];
    });
    const width = frame.rows[0]?.reduce((sum, span) => sum + span.width, 0) ?? 0;
    const snapshot: FrameSnapshot = { rows: frame.rows, width, height: this.root.height, blocks };
    // Let OpenTUI finish its frame before the tree changes.
    queueMicrotask(() => {
      this.processFrame(snapshot);
      // From the tick to here: syncing the tree, OpenTUI's layout and drawing, then commit and paint.
      this.stats.renderMs += performance.now() - this.tickStartedAt;
    });
  }

  private processFrame(snapshot: FrameSnapshot): void {
    this.awaitingFrame = false;
    if (this.state === 'done' || this.state === 'created') {
      return;
    }
    if (this.awaitingRelayout()) {
      this.armAutoRelayout();
      this.dirty = true;
      return;
    }
    if (snapshot.width !== this.host.size.cols) {
      // Drawn at another width: OpenTUI applies a resize only after the frame it is drawing, so the
      // first frame after one can still be at the old width. Its rows would wrap in the terminal, put
      // committed text where the live region thinks it is not, and get painted over. Draw again.
      this.headless.resize({ width: this.host.size.cols, height: this.bufferRows });
      this.dirty = true;
      this.afterFrame();
      return;
    }
    if (snapshot.height > snapshot.rows.length) {
      // The live content outgrew the buffer: grow it and draw again.
      this.bufferRows = snapshot.height + this.host.size.rows;
      this.headless.resize({ width: this.host.size.cols, height: this.bufferRows });
      this.dirty = true;
      this.afterFrame();
      return;
    }

    // The stable prefix, by what this frame drew: blocks in order, up to the first one not final.
    let commitEnd = 0;
    let committedBlocks = 0;
    for (const block of snapshot.blocks) {
      if (!block.final) {
        break;
      }
      commitEnd = block.bottom;
      committedBlocks++;
    }
    // A streaming message right after the stable prefix can give up its finished blocks too.
    const streaming = snapshot.blocks[committedBlocks];
    let split: { key: string; split: StableSplit } | undefined;
    if (streaming?.split && streaming.split.row > commitEnd) {
      split = { key: streaming.key, split: streaming.split };
      commitEnd = streaming.split.row;
    }

    const commit = snapshot.rows.slice(0, commitEnd);
    const live = this.clip(snapshot.rows.slice(commitEnd, snapshot.height));
    this.region.update(commit, live);
    this.stats.frames++;
    this.afterCommit(snapshot, commitEnd, committedBlocks, split);
  }

  /** After the rows of the stable prefix went to scrollback: their block views go, and the rest draws again. */
  private afterCommit(snapshot: FrameSnapshot, commitEnd: number, committedBlocks: number, split: { key: string; split: StableSplit } | undefined): void {
    if (this.stats.firstPaintMs < 0) {
      this.stats.firstPaintMs = this.now() - this.startedAt;
    }

    if (committedBlocks > 0) {
      const end = this.model.committed + committedBlocks;
      for (const block of this.model.blocks.slice(this.model.committed, end)) {
        const view = this.views.get(block.key);
        if (view) {
          this.destroyView(block.key, view);
        }
      }
      this.model.markCommitted(end);
      this.dirty = true;
      this.shrinkBuffer(snapshot.height - commitEnd);
    }
    if (split) {
      const view = this.views.get(split.key);
      if (view?.kind === 'message') {
        view.message.cut(split.split.byteOffset);
        this.dirty = true;
      }
    }
    this.afterFrame();
  }

  /** After a tall block went to scrollback, draw into a small buffer again: every frame draws the whole buffer. */
  private shrinkBuffer(liveRows: number): void {
    const target = Math.max(this.baseBufferRows(), liveRows + this.host.size.rows);
    if (this.bufferRows > target * 2) {
      this.bufferRows = target;
      this.headless.resize({ width: this.host.size.cols, height: this.bufferRows });
    }
  }

  private afterFrame(): void {
    if (this.dirty) {
      this.schedule();
      return;
    }
    if (this.isIdle()) {
      this.releaseIdleWaiters();
    }
  }

  /** The live rows, cut to the tail that fits, with a note saying how much is above. */
  private clip(rows: readonly PaintRow[]): readonly PaintRow[] {
    const max = this.region.maxLiveRows;
    if (rows.length <= max) {
      return rows;
    }
    const kept = rows.slice(rows.length - (max - 1));
    const hidden = rows.length - kept.length;
    const note = lineToPaintRow(fitLine([seg(`  ⋮ ${hidden} more line${hidden === 1 ? '' : 's'} above, in scrollback when done`, 'muted')], this.host.size.cols));
    return [note, ...kept];
  }

  private isIdle(): boolean {
    return !this.awaitingFrame && !this.dirty && !this.frameTimer
      && this.model.stablePrefixEnd === this.model.committed
      && this.model.blocks.slice(this.model.committed).every((block) => this.views.get(block.key)?.syncedVersion === block.version);
  }

  private whenIdle(): Promise<void> {
    if (this.isIdle() && this.model.committed === this.model.blocks.length) {
      return Promise.resolve();
    }
    this.schedule();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  private releaseIdleWaiters(): void {
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const resolve of waiters) {
      resolve();
    }
  }

  private close(): void {
    this.region.finish();
    this.state = 'done';
    clearTimeout(this.frameTimer);
    this.frameTimer = undefined;
    this.timers.clearInterval(this.spinnerTimer);
    this.releaseIdleWaiters();
    this.releaseRenderer();
  }

  /** A finished view keeps nothing: its block views and its OpenTUI renderer go. */
  private releaseRenderer(): void {
    if (this.released) {
      return;
    }
    this.released = true;
    for (const [key, view] of this.views) {
      this.destroyView(key, view);
    }
    this.headless.destroy();
  }

  // ─── Formatting ───────────────────────────────────────────────────────────

  private formatContext(): FormatContext {
    return {
      cwd: this.options.cwd,
      home: this.options.home,
      width: this.host.size.cols,
      agentName: this.agentName,
      spinner: spinnerFrame(this.now()),
    };
  }

  private blockLines(block: Block, context: FormatContext): Line[] {
    switch (block.kind) {
      case 'tool':
        return formatTool(block.tool, context, { stopped: block.stopped, permission: block.permission });
      case 'line':
        return lineBlockLines(block, context);
      case 'message':
        return [];
    }
  }

  /** The live rows under the blocks: plan, permission prompt, thought and status. */
  private extraLines(context: FormatContext): Line[] {
    const lines: Line[] = [];
    const hasContentAbove = (): boolean => lines.length > 0 || this.model.blocks.length > this.model.committed || this.model.committed > 0;
    const gap = (): void => {
      if (hasContentAbove()) {
        lines.push([]);
      }
    };

    const { plan, ended } = this.model;
    if (plan && plan.length > 0 && !ended) {
      gap();
      lines.push(...formatPlan(plan, context.width));
    }

    const request = this.model.permissions[0];
    if (request?.requestId !== this.shownRequestId) {
      this.shownRequestId = request?.requestId;
      this.promptShownAt = this.now();
      this.selectedOption = 0;
    }
    if (request && !ended) {
      gap();
      lines.push(...formatPermission({ title: request.title, options: request.options, selected: this.selectedOption }, context));
    }

    if (!ended && this.state !== 'finishing') {
      lines.push([]);
      const phase = this.model.phase;
      if (this.model.thought && phase.type === 'thinking') {
        const thought = formatThought(this.model.thought, context.width);
        if (thought) {
          lines.push(thought);
        }
      }
      const startedAt = this.model.startedAt ?? this.startedAt;
      lines.push(formatStatus({
        phase: phaseText(phase, this.agentName, context),
        elapsedMs: this.now() - Math.min(startedAt, this.now()),
        hints: phase.type === 'waiting'
          ? [
            { text: '←→ select', priority: 3 },
            { text: 'enter confirm', short: 'enter', priority: 1 },
            { text: 'esc reject', short: 'esc', priority: 2 },
          ]
          : phase.type === 'stopping'
            ? []
            : [{ text: 'esc background', short: 'esc bg', priority: 2 }, { text: '^c stop', short: '^c', priority: 1 }],
      }, context));
    }
    return lines;
  }
}

const firstOption = (request: PermissionRequest, type: 'allow' | 'reject') =>
  request.options.find((option) => option.kind.startsWith(type));

const shiftSplit = (split: StableSplit | undefined, offset: number): StableSplit | undefined =>
  split && { row: split.row + offset, byteOffset: split.byteOffset };

/**
 * Where a streaming message can be cut, in frame rows: between rows of the
 * paragraph it is writing when that can be done with certainty (so the
 * live region keeps only that paragraph's last row), else before its first
 * block not finished yet. `offset` is the message's first row in the frame.
 */
const messageSplit = (message: MessageView, rows: readonly PaintRow[], offset: number): StableSplit | undefined => {
  const rowText = (row: number): string => (rows[offset + row] ?? []).map((span) => span.text).join('').trimEnd();
  return shiftSplit(message.lineSplit(rowText) ?? message.stableSplit(), offset);
};

const phaseText = (phase: Phase, agentName: string, context: FormatContext): string => {
  switch (phase.type) {
    case 'starting':
      return `Starting ${agentName}…`;
    case 'thinking':
    case 'ended':
      return 'Thinking';
    case 'writing':
      return 'Writing';
    case 'running':
      return `Running ${shortToolTitle(phase.tool, context, Math.max(12, Math.floor(context.width / 2) - 12))}`;
    case 'waiting':
      return 'Waiting for you';
    case 'stopping':
      return 'Stopping…';
  }
};

export const lineBlockLines = (block: LineBlock, context: FormatContext): Line[] => {
  const { content } = block;
  switch (content.type) {
    case 'notice':
      return formatNotice(content.level, content.text, context.width);
    case 'mode':
      return [formatModeChange(content.name, context.width)];
    case 'permission':
      return [formatPermissionOutcome(content.title, content.outcome, context)];
    case 'plan':
      return formatPlan(content.entries, context.width);
    case 'summary':
      return formatSummary(content.ended, { toolCount: content.toolCount, produced: content.produced, noticed: content.noticed }, context);
  }
};
