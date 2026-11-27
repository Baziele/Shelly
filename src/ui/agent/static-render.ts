import { BoxRenderable } from '@opentui/core';
import { encodeRow } from '../../render/inline-painter.js';
import type { PaintRow } from '../../render/live-region.js';
import type { ColorDepth } from '../../render/sgr.js';
import { HeadlessRenderer } from '../headless-renderer.js';
import { createMarkdownStyle, MessageView } from './message-view.js';

const FIRST_BUFFER_ROWS = 200;

/**
 * Markdown laid out once at `width`, as paint rows: for output printed
 * statically (history, fast-mode answers) rather than streamed.
 */
export const renderMarkdownRows = async (markdown: string, width: number): Promise<PaintRow[]> => {
  let bufferRows = FIRST_BUFFER_ROWS;
  const headless = HeadlessRenderer.create({ width, height: bufferRows });
  try {
    const root = new BoxRenderable(headless.renderer, { flexDirection: 'column', width: '100%' });
    const message = new MessageView(headless.renderer, createMarkdownStyle(headless.renderer));
    root.add(message.root);
    headless.renderer.root.add(root);
    message.update(markdown, true);

    for (let attempt = 0; attempt < 4; attempt++) {
      const frame = await new Promise<{ rows: PaintRow[]; height: number }>((resolve) => {
        headless.onFrame((captured) => resolve({ rows: captured.rows.map((row) => [...row]), height: root.height }));
        headless.requestRender();
      });
      if (frame.height <= bufferRows) {
        return trimBlankRows(frame.rows.slice(0, frame.height));
      }
      bufferRows = frame.height + 10;
      headless.resize({ width, height: bufferRows });
    }
    return [];
  } finally {
    headless.destroy();
  }
};

const isBlankRow = (row: PaintRow): boolean => row.every((span) => span.text.trim() === '' && span.style.bg.kind === 'default');

const trimBlankRows = (rows: PaintRow[]): PaintRow[] => {
  let start = 0;
  let end = rows.length;
  while (start < end && isBlankRow(rows[start]!)) {
    start++;
  }
  while (end > start && isBlankRow(rows[end - 1]!)) {
    end--;
  }
  return rows.slice(start, end);
};

/** Rows as text for the terminal: one line each, CRLF-terminated (the terminal is in raw mode). */
export const rowsToText = (rows: readonly PaintRow[], colorDepth: ColorDepth): string =>
  rows.map((row) => `${encodeRow(row, colorDepth)}\u001b[0m\r\n`).join('');
