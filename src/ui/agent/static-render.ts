import { BoxRenderable } from '@opentui/core';
import { encodeRow } from '../../render/inline-painter.js';
import type { PaintRow } from '../../render/live-region.js';
import type { ColorDepth } from '../../render/sgr.js';
import { HeadlessRenderer } from '../headless-renderer.js';
import { seg } from './lines.js';
import { createMarkdownStyle, MessageView } from './message-view.js';
import { lineToPaintRow } from './paint-line.js';

const FIRST_BUFFER_ROWS = 200;
/**
 * The tallest layout tried. Past it (a 20,000-row answer), the rows that fit
 * are kept with a note saying how many were left out, rather than nothing.
 */
export const MAX_BUFFER_ROWS = 20_000;

/**
 * Markdown laid out once at `width`, as paint rows: for output printed
 * statically (history, fast-mode answers) rather than streamed. The layout
 * grows until the whole document fits.
 */
export const renderMarkdownRows = async (markdown: string, width: number, maxRows = MAX_BUFFER_ROWS): Promise<PaintRow[]> => {
  let bufferRows = Math.min(FIRST_BUFFER_ROWS, maxRows);
  const headless = HeadlessRenderer.create({ width, height: bufferRows });
  try {
    // flexShrink 0: the box must report its full height, not the buffer's, or a tall answer is cut short.
    const root = new BoxRenderable(headless.renderer, { flexDirection: 'column', width: '100%', flexShrink: 0 });
    const message = new MessageView(headless.renderer, createMarkdownStyle(headless.renderer));
    root.add(message.root);
    headless.renderer.root.add(root);
    message.update(markdown, true);

    for (;;) {
      const frame = await new Promise<{ rows: PaintRow[]; height: number }>((resolve) => {
        headless.onFrame((captured) => resolve({ rows: captured.rows.map((row) => [...row]), height: root.height }));
        headless.requestRender();
      });
      if (frame.height <= bufferRows) {
        return trimBlankRows(frame.rows.slice(0, frame.height));
      }
      if (bufferRows >= maxRows) {
        const hidden = frame.height - bufferRows;
        return [...trimBlankRows(frame.rows), lineToPaintRow([seg(`… (${hidden} more lines not shown)`, 'muted')])];
      }
      bufferRows = Math.min(maxRows, frame.height + 10);
      headless.resize({ width, height: bufferRows });
    }
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

/**
 * A fast-mode answer (or any finished markdown) as terminal text, CRLF per
 * row, ready to print below the echoed request.
 */
export const renderAnswer = async (markdown: string, width: number, colorDepth: ColorDepth): Promise<string> =>
  rowsToText(await renderMarkdownRows(markdown, width), colorDepth);
