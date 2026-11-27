import { StyledText, TextAttributes, type RGBA, type TextChunk } from '@opentui/core';
import { theme, type Tone } from '../theme.js';
import type { Line, Segment } from './lines.js';

const TONE_COLORS: Record<Tone, RGBA> = {
  text: theme.text,
  accent: theme.accent,
  fast: theme.fast,
  muted: theme.muted,
  success: theme.success,
  error: theme.error,
  warning: theme.warning,
};

const toChunk = (segment: Segment): TextChunk => {
  let attributes = 0;
  if (segment.bold) {
    attributes |= TextAttributes.BOLD;
  }
  if (segment.italic) {
    attributes |= TextAttributes.ITALIC;
  }
  if (segment.strike) {
    attributes |= TextAttributes.STRIKETHROUGH;
  }
  return { __isChunk: true, text: segment.text, fg: TONE_COLORS[segment.tone ?? 'text'], attributes };
};

/** Lines as OpenTUI text, one row each. */
export const toStyledText = (lines: readonly Line[]): StyledText => {
  const chunks: TextChunk[] = [];
  lines.forEach((line, index) => {
    if (index > 0) {
      chunks.push({ __isChunk: true, text: '\n' });
    }
    chunks.push(...line.map(toChunk));
  });
  return new StyledText(chunks);
};
