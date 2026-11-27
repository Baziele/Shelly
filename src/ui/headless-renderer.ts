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
  private frameListener: ((frame: PaintFrame) => void) | undefined;

  private constructor(
    readonly renderer: CliRenderer,
    private readonly input: Readable,
    private readonly output: FakeTerminalOutput,
  ) {
    renderer.addPostProcessFn((buffer) => this.frameListener?.(this.captureFrame(buffer)));
  }

  static create(size: RendererSize): HeadlessRenderer {
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

    return new HeadlessRenderer(renderer, input, output);
  }

  onFrame(listener: (frame: PaintFrame) => void): void {
    this.frameListener = listener;
  }

  /** Deliver raw terminal input, exactly as the user typed it. */
  feed(data: string): void {
    this.input.emit('data', Buffer.from(data, 'utf8'));
  }

  resize(size: RendererSize): void {
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
