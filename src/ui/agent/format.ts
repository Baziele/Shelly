import * as nodePath from 'node:path';
import type {
  PermissionOption,
  PlanEntry,
  StopReason,
  ToolCall,
  ToolContent,
} from '../../protocol/schema.js';
import { truncateStart } from '../../render/text-width.js';
import { diffExcerpt, diffLines, diffStats, type DiffLine } from './diff.js';
import { alignRight, fitLine, lineWidth, oneLine, sanitizeText, seg, type Line, type Segment } from './lines.js';

/** Braille spinner, one frame per 80 ms. */
export const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;
export const SPINNER_INTERVAL_MS = 80;

export const spinnerFrame = (now: number): string =>
  SPINNER_FRAMES[Math.floor(now / SPINNER_INTERVAL_MS) % SPINNER_FRAMES.length]!;

export interface PathContext {
  /** The shell's working directory. */
  readonly cwd: string;
  readonly home: string;
}

export interface FormatContext extends PathContext {
  readonly width: number;
  readonly agentName: string;
  /** The spinner glyph to draw this frame. */
  readonly spinner: string;
}

// ─── Paths and titles ───────────────────────────────────────────────────────

/** `path` relative to the shell's directory when inside it, else with `~` for home. */
export const shortenPath = (path: string, context: PathContext): string => {
  if (!nodePath.isAbsolute(path)) {
    return path;
  }
  const normalized = nodePath.normalize(path);
  const cwd = nodePath.normalize(context.cwd);
  if (normalized === cwd) {
    return '.';
  }
  if (cwd !== nodePath.sep && normalized.startsWith(cwd + nodePath.sep)) {
    return normalized.slice(cwd.length + 1);
  }
  const home = context.home && nodePath.normalize(context.home);
  if (home && home !== nodePath.sep) {
    if (normalized === home) {
      return '~';
    }
    if (normalized.startsWith(home + nodePath.sep)) {
      return `~${normalized.slice(home.length)}`;
    }
  }
  return normalized;
};

// An absolute path in free text: starts at a word boundary, runs to whitespace or a closing quote/bracket.
const ABSOLUTE_PATH = /(^|[\s('"`=:])(\/[^\s'"`()<>,;]+)/g;

/** Absolute paths in `text` shortened with `shortenPath`. */
export const shortenPathsIn = (text: string, context: PathContext): string =>
  text.replace(ABSOLUTE_PATH, (_match, before: string, path: string) => {
    const trailing = /[.:]+$/.exec(path)?.[0] ?? '';
    const core = trailing ? path.slice(0, -trailing.length) : path;
    return before + shortenPath(core, context) + trailing;
  });

/** An agent's tool title made tidy for one row: one line, paths shortened, wrapping backticks dropped. */
export const tidyTitle = (title: string, context: PathContext): string => {
  let text = oneLine(title);
  const wrapped = /^`([^`]+)`$/.exec(text);
  if (wrapped) {
    text = wrapped[1]!.trim();
  }
  return shortenPathsIn(text, context) || 'Tool call';
};

// ─── Tool calls ─────────────────────────────────────────────────────────────

const MAX_OUTPUT_LINES = 4;
const MAX_DIFF_LINES = 8;
const DETAIL_INDENT = '  ';
const ERROR_PATTERN = /\b(error|failed|failure|fatal|exception|denied|not found|cannot|can't|unable)\b/i;

const textOf = (content: readonly ToolContent[]): string =>
  content.flatMap((item) => (item.type === 'text' ? [item.text] : [])).join('\n');

const diffsOf = (content: readonly ToolContent[]) =>
  content.flatMap((item) => (item.type === 'diff' ? [item] : []));

const nonEmptyLines = (text: string): string[] =>
  sanitizeText(text).split('\n').map((line) => line.trimEnd()).filter((line) => line.trim() !== '');

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`;

/** The glyph a tool row starts with. A tool still running when the turn ended shows as stopped. */
const toolGlyph = (tool: ToolCall, spinner: string, stopped: boolean): Segment => {
  switch (tool.status) {
    case 'pending':
      return stopped ? seg('◼', 'muted') : seg('○', 'muted');
    case 'in_progress':
      return stopped ? seg('◼', 'muted') : seg(spinner, 'accent');
    case 'completed':
      return seg('●', 'success');
    case 'failed':
      return seg('✗', 'error');
  }
};

/** What a tool row says after its title: a count or an edit's size. */
const toolSuffix = (tool: ToolCall): Segment[] => {
  const diffs = diffsOf(tool.content);
  if (diffs.length > 0) {
    const stats = diffs.map((diff) => diffStats(diffLines(diff.oldText, diff.newText)));
    const added = stats.reduce((sum, stat) => sum + stat.added, 0);
    const removed = stats.reduce((sum, stat) => sum + stat.removed, 0);
    const files = diffs.length > 1 ? [seg(` in ${diffs.length} files`, 'muted')] : [];
    return [seg('  '), seg(`+${added}`, 'success'), seg(' '), seg(`−${removed}`, 'error'), ...files];
  }
  if (tool.status !== 'completed') {
    return [];
  }
  const text = textOf(tool.content);
  if (!text.trim()) {
    return [];
  }
  switch (tool.kind) {
    case 'read':
      return [seg(` · ${plural(sanitizeText(text).replace(/\n$/, '').split('\n').length, 'line')}`, 'muted')];
    case 'search':
      return [seg(` · ${plural(nonEmptyLines(text).length, 'result')}`, 'muted')];
    default:
      return [];
  }
};

const formatDiffLine = (line: DiffLine, width: number): Line => {
  switch (line.kind) {
    case 'add':
      return fitLine([seg(DETAIL_INDENT), seg('+ ', 'success'), seg(oneLineCode(line.text), 'success')], width);
    case 'remove':
      return fitLine([seg(DETAIL_INDENT), seg('- ', 'error'), seg(oneLineCode(line.text), 'error')], width);
    case 'context':
      return fitLine([seg(DETAIL_INDENT), seg('  ', 'muted'), seg(oneLineCode(line.text), 'muted')], width);
  }
};

/** A code line for one row: control characters gone, tabs expanded, trailing space trimmed. */
const oneLineCode = (text: string): string => sanitizeText(text).replace(/\n/g, ' ').trimEnd();

const outputTail = (text: string, width: number, failed: boolean): Line[] => {
  const lines = nonEmptyLines(text);
  const shown = lines.slice(-MAX_OUTPUT_LINES);
  const result: Line[] = [];
  if (lines.length > shown.length) {
    result.push([seg(`${DETAIL_INDENT}… ${plural(lines.length - shown.length, 'more line')}`, 'muted')]);
  }
  for (const line of shown) {
    const tone = failed && ERROR_PATTERN.test(line) ? 'error' : 'muted';
    result.push(fitLine([seg(`${DETAIL_INDENT}│ `, 'muted'), seg(line, tone)], width));
  }
  return result;
};

/** The first line of a failed tool's output that reads like an error. */
export const firstErrorLine = (tool: ToolCall): string | undefined => {
  const lines = nonEmptyLines(textOf(tool.content)).map((line) => line.trim());
  return lines.find((line) => ERROR_PATTERN.test(line)) ?? lines[0];
};

export interface ToolFormatOptions {
  /** The turn ended while the tool was still pending or running. */
  readonly stopped?: boolean;
}

/** A tool call as a title row and compact detail rows. */
export const formatTool = (tool: ToolCall, context: FormatContext, options: ToolFormatOptions = {}): Line[] => {
  const { width } = context;
  const glyph = toolGlyph(tool, context.spinner, options.stopped ?? false);
  const suffix = toolSuffix(tool);
  const title = tidyTitle(tool.title, context);
  // Commands read as commands.
  const prompt: Segment[] = tool.kind === 'execute' ? [seg('$ ', 'muted')] : [];
  const titleWidth = Math.max(8, width - 2 - lineWidth(prompt) - lineWidth(suffix));
  const titleRow: Line = [glyph, seg(' '), ...prompt, ...fitLine([seg(title, tool.status === 'pending' ? 'muted' : undefined)], titleWidth), ...suffix];
  const rows: Line[] = [fitLine(titleRow, width)];

  const diffs = diffsOf(tool.content);
  if (diffs.length > 0) {
    const first = diffs[0]!;
    const excerpt = diffExcerpt(diffLines(first.oldText, first.newText), MAX_DIFF_LINES);
    rows.push(...excerpt.lines.map((line) => formatDiffLine(line, width)));
    const more = excerpt.moreChanges + diffs.slice(1).reduce((sum, diff) => {
      const stats = diffStats(diffLines(diff.oldText, diff.newText));
      return sum + stats.added + stats.removed;
    }, 0);
    if (more > 0) {
      rows.push([seg(`${DETAIL_INDENT}… ${plural(more, 'more changed line')}`, 'muted')]);
    }
    return rows;
  }

  const text = textOf(tool.content);
  if (tool.kind === 'execute' && text.trim()) {
    rows.push(...outputTail(text, width, tool.status === 'failed'));
    return rows;
  }
  if (tool.status === 'failed') {
    const error = firstErrorLine(tool);
    if (error) {
      rows.push(fitLine([seg(DETAIL_INDENT), seg(error, 'error')], width));
    }
  }
  return rows;
};

/** A tool call as one row, for history: no detail. */
export const formatToolSummary = (tool: ToolCall, context: FormatContext): Line =>
  formatTool({ ...tool, content: tool.content.filter((item) => item.type === 'diff') }, context, { stopped: true })[0]!;

/** The tool title for the status line's "Running …". */
export const shortToolTitle = (tool: ToolCall, context: PathContext, maxWidth = 40): string =>
  fitLine([seg(tidyTitle(tool.title, context))], maxWidth).map((segment) => segment.text).join('');

// ─── Thoughts, plans, notices ───────────────────────────────────────────────

/** The latest line of a thought, muted and italic. */
export const formatThought = (text: string, width: number): Line | undefined => {
  const last = nonEmptyLines(text).at(-1)?.trim();
  return last ? fitLine([seg('✻ ', 'muted'), seg(last, 'muted', { italic: true })], width) : undefined;
};

export const formatPlan = (entries: readonly PlanEntry[], width: number): Line[] => entries.map((entry) => {
  const text = oneLine(entry.content);
  switch (entry.status) {
    case 'completed':
      return fitLine([seg('☑ ', 'success'), seg(text, 'muted')], width);
    case 'in_progress':
      return fitLine([seg('◐ ', 'accent'), seg(text, undefined, { bold: true })], width);
    case 'pending':
      return fitLine([seg('☐ ', 'muted'), seg(text)], width);
  }
});

export const formatNotice = (level: 'info' | 'warning' | 'error', text: string, width: number): Line => {
  const body = oneLine(text);
  switch (level) {
    case 'info':
      return fitLine([seg(`· ${body}`, 'muted')], width);
    case 'warning':
      return fitLine([seg('! ', 'warning', { bold: true }), seg(body, 'warning')], width);
    case 'error':
      return fitLine([seg('✗ ', 'error'), seg(body, 'error')], width);
  }
};

export const formatModeChange = (modeName: string, width: number): Line =>
  fitLine([seg(`◇ Mode: ${oneLine(modeName)}`, 'muted')], width);

// ─── Permission prompts ─────────────────────────────────────────────────────

export interface PermissionView {
  readonly title: string;
  readonly options: readonly PermissionOption[];
  readonly selected: number;
}

const optionLabel = (option: PermissionOption): string => oneLine(option.name) || {
  allow_once: 'Allow once',
  allow_always: 'Allow always',
  reject_once: 'Reject',
  reject_always: 'Always reject',
}[option.kind];

/**
 * A permission prompt: its question, then its options side by side, or one
 * per row when they do not fit across.
 */
export const formatPermission = (prompt: PermissionView, context: FormatContext): Line[] => {
  const { width } = context;
  const title = tidyTitle(prompt.title, context);
  const question = fitLine([seg('? ', 'warning', { bold: true }), seg(`${context.agentName} wants to: `, undefined, { bold: true }), seg(title)], width);
  const labels = prompt.options.map(optionLabel);

  const option = (label: string, index: number): Segment[] => index === prompt.selected
    ? [seg('❯ ', 'accent', { bold: true }), seg(label, 'accent', { bold: true })]
    : [seg('  '), seg(label)];

  const across: Segment[] = [seg('  ')];
  labels.forEach((label, index) => across.push(...option(label, index), seg(' ')));
  if (lineWidth(across) <= width) {
    return [question, across];
  }
  return [question, ...labels.map((label, index) => fitLine([seg('  '), ...option(label, index)], width))];
};

const OUTCOME: Record<PermissionOption['kind'], { glyph: string; verb: string; tone: 'muted' | 'error' }> = {
  allow_once: { glyph: '✓', verb: 'Allowed once', tone: 'muted' },
  allow_always: { glyph: '✓', verb: 'Always allowed', tone: 'muted' },
  reject_once: { glyph: '✗', verb: 'Rejected', tone: 'muted' },
  reject_always: { glyph: '✗', verb: 'Always rejected', tone: 'muted' },
};

/** What became of a permission prompt, as one muted row. `null`: it was cancelled. */
export const formatPermissionOutcome = (title: string, kind: PermissionOption['kind'] | null, context: FormatContext): Line => {
  const text = tidyTitle(title, context);
  if (kind === null) {
    return fitLine([seg(`◼ Cancelled: ${text}`, 'muted')], context.width);
  }
  const outcome = OUTCOME[kind];
  return fitLine([seg(`${outcome.glyph} ${outcome.verb}: ${text}`, outcome.tone)], context.width);
};

// ─── Status and summary ─────────────────────────────────────────────────────

export const formatDuration = (ms: number): string => {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
  }
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
};

export const relativeTime = (at: number, now: number): string => {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 45) {
    return 'just now';
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  const days = Math.round(hours / 24);
  if (days < 30) {
    return days === 1 ? 'yesterday' : `${days}d ago`;
  }
  return new Date(at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: days > 300 ? 'numeric' : undefined });
};

export interface StatusLineView {
  readonly phase: string;
  readonly elapsedMs: number;
  readonly hints: string;
}

/** The live status row: spinner, phase and time on the left, key hints on the right when they fit. */
export const formatStatus = (status: StatusLineView, context: FormatContext): Line => {
  const left: Line = [
    seg(context.spinner, 'accent'),
    seg(' '),
    seg(status.phase),
    seg(` · ${formatDuration(status.elapsedMs)}`, 'muted'),
  ];
  return alignRight(left, status.hints ? [seg(status.hints, 'muted')] : [], context.width);
};

export interface TurnOutcome {
  readonly stopReason: StopReason;
  readonly error: string | null;
  readonly durationMs: number;
}

/** The row a finished turn leaves behind. */
export const formatSummary = (outcome: TurnOutcome, toolCount: number, context: FormatContext): Line => {
  const time = formatDuration(outcome.durationMs);
  const agent = context.agentName;
  const error = outcome.error ? oneLine(outcome.error) : undefined;
  const muted = (text: string): Line => fitLine([seg(text, 'muted')], context.width);
  const failed = (text: string): Line => fitLine([seg('✗ ', 'error'), seg(text, 'error')], context.width);

  switch (outcome.stopReason) {
    case 'end_turn':
      return muted(`✓ ${time}${toolCount > 0 ? ` · ${plural(toolCount, 'tool')}` : ''}`);
    case 'cancelled':
      return muted(`◼ Stopped · ${time}`);
    case 'max_tokens':
      return muted(`◼ Stopped: ${agent} reached its output limit · ${time}`);
    case 'max_turn_requests':
      return muted(`◼ Stopped: ${agent} reached its step limit for one turn · ${time}`);
    case 'refusal':
      return failed(`${agent} declined to continue`);
    case 'interrupted':
      return failed(error ? `Interrupted: ${error}` : `Interrupted: ${agent} stopped unexpectedly`);
    case 'error':
      return failed(error ?? `${agent} failed`);
  }
};

/** Shown when the user sends a running turn to the background. */
export const formatBackgrounded = (context: FormatContext): Line =>
  fitLine([seg('↳ ', 'accent'), seg(`${context.agentName} is still working · `, 'muted'), seg('::', 'accent', { bold: true }), seg(' to check back', 'muted')], context.width);

/** The tail of `text` that fits in `width`, for previews. */
export const previewTail = (text: string, width: number): string => truncateStart(oneLine(text), width);
