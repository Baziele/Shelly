import { Readable, Writable } from 'node:stream';
import { CliRenderer, type OptimizedBuffer, type RGBA } from '@opentui/core';
import type { PaintFrame, PaintSpan } from '../render/inline-painter.js';
import { DEFAULT_COLOR, type CellColor } from '../render/sgr.js';

export interface RendererSize {
  readonly width: number;
  readonly height: number;
}

/**
 * Process-level events OpenTUI subscribes to so a standalone app can report
 * errors. Shelly owns the real terminal and its own crash handling, and the
 * renderer must never write to the screen behind Shelly's back, so these
 * subscriptions are removed after construction.
 */
const PROCESS_EVENTS_OWNED_BY_SHELLY = ['warning', 'uncaughtException', 'unhandledRejection'] as const;

let live = 0;

/** OpenTUI refuses a renderer of more cells than this (width × height). */
export const MAX_RENDERER_CELLS = 1_000_000;

/** The tallest renderer OpenTUI allows at `width`. */
export const maxRendererRows = (width: number): number =>
  Math.max(1, Math.floor(MAX_RENDERER_CELLS / Math.max(1, width)));

/** `size`, no taller than OpenTUI allows: asked for more, it throws. */
const clampSize = (size: RendererSize): RendererSize =>
  ({ width: size.width, height: Math.min(size.height, maxRendererRows(size.width)) });

type FakeTerminalOutput = Writable & { columns: number; rows: number; isTTY: true };

/**
 * An OpenTUI renderer that never touches the real terminal. It reads
 * keystrokes Shelly feeds it, lays out and draws components into memory, and
 * hands each finished frame to a listener that paints it where Shelly wants.
 *
 * None of OpenTUI's screen modes can draw starting at an arbitrary cursor
 * position (split-footer always pins to the bottom), which is what keeping the
 * shell prompt on screen requires. So OpenTUI handles layout, editing and
 * styling while Shelly handles placement.
 */
export class HeadlessRenderer {
  /** Renderers created and not yet destroyed, process-wide: for leak checks. */
  static get liveCount(): number {
    return live;
  }

  private frameListener: ((frame: PaintFrame) => void) | undefined;
  private destroyed = false;

  private constructor(
    readonly renderer: CliRenderer,
    private readonly input: Readable,
    private readonly output: FakeTerminalOutput,
  ) {
    renderer.addPostProcessFn((buffer) => this.frameListener?.(this.captureFrame(buffer)));
  }

  static create(requested: RendererSize): HeadlessRenderer {
    const size = clampSize(requested);
    const input = new Readable({ read() {} });
    const output: FakeTerminalOutput = Object.assign(
      new Writable({ write: (_chunk, _encoding, callback) => callback() }),
      { columns: size.width, rows: size.height, isTTY: true as const },
    );

    const listenersBefore = new Map(
      PROCESS_EVENTS_OWNED_BY_SHELLY.map((event) => [event, new Set(process.listeners(event))]),
    );

    const renderer = new CliRenderer(
      input as unknown as NodeJS.ReadStream,
      output as unknown as NodeJS.WriteStream,
      size.width,
      size.height,
      {
        bufferedOutput: 'memory',
        screenMode: 'main-screen',
        externalOutputMode: 'passthrough',
        consoleMode: 'disabled',
        useMouse: false,
        useKittyKeyboard: null,
        exitOnCtrlC: false,
        exitSignals: [],
      },
    );

    for (const [event, before] of listenersBefore) {
      for (const listener of process.listeners(event)) {
        if (!before.has(listener)) {
          process.off(event, listener as (...args: unknown[]) => void);
        }
      }
    }

    live++;
    return new HeadlessRenderer(renderer, input, output);
  }

  onFrame(listener: (frame: PaintFrame) => void): void {
    this.frameListener = listener;
  }

  /** Deliver raw terminal input, exactly as the user typed it. */
  feed(data: string): void {
    this.input.emit('data', Buffer.from(data, 'utf8'));
  }

  resize(requested: RendererSize): void {
    const size = clampSize(requested);
    if (size.width === this.output.columns && size.height === this.output.rows) {
      return;
    }
    this.output.columns = size.width;
    this.output.rows = size.height;
    this.renderer.resize(size.width, size.height);
  }

  requestRender(): void {
    this.renderer.requestRender();
  }

  destroy(): void {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    live--;
    this.frameListener = undefined;
    this.renderer.destroy();
  }

  private captureFrame(buffer: OptimizedBuffer): PaintFrame {
    const rows = buffer.getSpanLines().map((line) => line.spans.map((span): PaintSpan => ({
      text: span.text,
      width: span.width,
      style: { fg: toCellColor(span.fg), bg: toCellColor(span.bg), attributes: span.attributes & 0xff },
    })));
    const cursor = this.renderer.getCursorState();

    return { rows, cursor: { row: cursor.y, col: cursor.x, visible: cursor.visible } };
  }
}

const toCellColor = (color: RGBA): CellColor => {
  switch (color.intent) {
    case 'default':
      return DEFAULT_COLOR;
    case 'indexed':
      return { kind: 'indexed', index: color.slot };
    case 'rgb': {
      const [r, g, b, a] = color.toInts();
      return a === 0 ? DEFAULT_COLOR : { kind: 'rgb', r, g, b };
    }
  }
};
