import * as nodePath from 'node:path';
import type {
  PermissionOption,
  PlanEntry,
  StopReason,
  ToolCall,
  ToolContent,
} from '../../protocol/schema.js';
import { displayWidth, truncateEnd, truncateStart } from '../../render/text-width.js';
import { diffExcerpt, diffOf, diffStats, type DiffLine } from './diff.js';
import { alignRight, fitLine, lineWidth, oneLine, sanitizeText, seg, wrapMessage, wrapText, type Line, type Segment } from './lines.js';

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
/** What agents call a command before they know it: shown as a name, not as `$ Terminal`. */
const GENERIC_COMMAND_TITLE = /^(?:terminal|bash|shell|command|run command|execute)$/i;
/** `Run \`pnpm test\``, `Running \`make\``, `Terminal: \`ls\``: a verb before the command in backticks. */
const VERBED_COMMAND = /^(?:run|running|ran|execute|executing|terminal)\s*:?\s+`([^`]+)`$/i;

/**
 * An execute tool's title as the command it runs, when it is one: without
 * backticks or a leading verb. Undefined for a generic name (Claude Code's
 * "Terminal" before the command is known), which shows as it is.
 */
export const commandTitle = (title: string, context?: PathContext): string | undefined => {
  let text = oneLine(title);
  const verbed = VERBED_COMMAND.exec(text);
  if (verbed) {
    text = verbed[1]!.trim();
  }
  const wrapped = /^`([^`]+)`$/.exec(text);
  if (wrapped) {
    text = wrapped[1]!.trim();
  }
  if (context) {
    text = stripCdIntoCwd(text, context);
  }
  return text === '' || GENERIC_COMMAND_TITLE.test(text) ? undefined : text;
};

/** `cd "." && make`, or `cd` into the shell's own directory first: only `make` says anything. */
const stripCdIntoCwd = (command: string, context: PathContext): string => {
  const match = /^cd\s+("[^"]*"|'[^']*'|\S+)\s*&&\s*(.+)$/.exec(command);
  if (!match) {
    return command;
  }
  const target = match[1]!.replace(/^["']|["']$/g, '');
  const here = target === '.' || target === './' || nodePath.normalize(target) === nodePath.normalize(context.cwd);
  return here ? match[2]!.trim() : command;
};

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
    const stats = diffs.map((diff) => diffStats(diffOf(diff)));
    const added = stats.reduce((sum, stat) => sum + stat.added, 0);
    const removed = stats.reduce((sum, stat) => sum + stat.removed, 0);
    const files = diffs.length > 1 ? [seg(` in ${diffs.length} files`, 'muted')] : [];
    // Only the counts that say something: a pure addition shows no −0.
    const counts = [
      ...(added > 0 ? [seg(`+${added}`, 'success')] : []),
      ...(removed > 0 ? [seg(`−${removed}`, 'error')] : []),
    ].flatMap((count, index) => (index === 0 ? [count] : [seg(' '), count]));
    return counts.length > 0 || files.length > 0 ? [seg('  '), ...counts, ...files] : [];
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

/** Lines of a failed command's output worth showing: those that read like errors, and the last. */
const FAILURE_PATTERN = /error|failed|fatal|exception/i;
/** Rows an error line of a failed tool's output may wrap to before it is cut. */
const MAX_ERROR_ROWS = 3;

const outputTail = (text: string, width: number, failed: boolean): Line[] => {
  const lines = nonEmptyLines(text);
  let shown = lines.slice(-MAX_OUTPUT_LINES).map((line, index, tail) => ({ line, at: lines.length - tail.length + index }));
  if (failed && lines.length > MAX_OUTPUT_LINES) {
    // The real error is often above the last lines (a compiler's message, then make's summary).
    const errors = lines.map((line, at) => ({ line, at })).filter(({ line }) => FAILURE_PATTERN.test(line));
    const last = { line: lines.at(-1)!, at: lines.length - 1 };
    if (errors.length > 0) {
      shown = [...errors.filter(({ at }) => at !== last.at).slice(0, MAX_OUTPUT_LINES - 1), last];
    }
  }
  const gutter = seg(`${DETAIL_INDENT}│ `, 'muted');
  const result: Line[] = [];
  let next = 0;
  for (const { line, at } of shown) {
    if (at > next) {
      // What was left out, marked where it was, inside the gutter.
      result.push([gutter, seg(`… ${plural(at - next, 'more line')}`, 'muted')]);
    }
    const isError = failed && ERROR_PATTERN.test(line);
    if (isError) {
      // The line that says what went wrong wraps inside the gutter (to a few rows) rather than lose its end.
      const room = Math.max(8, width - lineWidth([gutter]));
      const rows = wrapText(line, room);
      const kept = rows.slice(0, MAX_ERROR_ROWS);
      kept.forEach((row, index) => {
        const last = index === kept.length - 1 && rows.length > kept.length;
        result.push(fitLine([gutter, seg(last ? truncateEnd(`${row} ${rows.slice(kept.length).join(' ')}`, room) : row, 'error')], width));
      });
    } else {
      result.push(fitLine([gutter, seg(line, 'muted')], width));
    }
    next = at + 1;
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
  /** How the user answered a permission prompt about the tool; null when it was cancelled. */
  readonly permission?: PermissionOption['kind'] | null;
}

const PERMISSION_NOTE: Record<PermissionOption['kind'], string> = {
  allow_once: 'allowed once',
  allow_always: 'always allowed',
  reject_once: 'rejected',
  reject_always: 'always rejected',
};

/** A tool call as a title row and compact detail rows. */
export const formatTool = (tool: ToolCall, context: FormatContext, options: ToolFormatOptions = {}): Line[] => {
  const { width } = context;
  const glyph = toolGlyph(tool, context.spinner, options.stopped ?? false);
  const permission = options.permission === undefined
    ? []
    : [seg(` · ${options.permission === null ? 'cancelled' : PERMISSION_NOTE[options.permission]}`, 'muted')];
  const suffix = [...toolSuffix(tool), ...permission];
  // Commands read as commands: `$ pnpm test`, not `$ Run \`pnpm test\``.
  const command = tool.kind === 'execute' ? commandTitle(tool.title, context) : undefined;
  const title = command === undefined ? tidyTitle(tool.title, context) : shortenPathsIn(command, context);
  const prompt: Segment[] = command !== undefined ? [seg('$ ', 'muted')] : [];
  const titleWidth = Math.max(8, width - 2 - lineWidth(prompt) - lineWidth(suffix));
  const titleRow: Line = [glyph, seg(' '), ...prompt, ...fitLine([seg(title, tool.status === 'pending' ? 'muted' : undefined)], titleWidth), ...suffix];
  const rows: Line[] = [fitLine(titleRow, width)];

  const diffs = diffsOf(tool.content);
  if (diffs.length > 0) {
    const first = diffs[0]!;
    const excerpt = diffExcerpt(diffOf(first), MAX_DIFF_LINES);
    rows.push(...excerpt.lines.map((line) => formatDiffLine(line, width)));
    const more = excerpt.moreChanges + diffs.slice(1).reduce((sum, diff) => {
      const stats = diffStats(diffOf(diff));
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
  const rejected = options.permission === null || options.permission?.startsWith('reject');
  if (tool.status === 'failed' && !rejected) {
    const error = firstErrorLine(tool);
    if (error) {
      rows.push(fitLine([seg(DETAIL_INDENT), seg(shortenPathsIn(error, context), 'error')], width));
    }
  }
  return rows;
};

/** A tool call as one row, for history: no detail. */
export const formatToolSummary = (tool: ToolCall, context: FormatContext): Line =>
  formatTool({ ...tool, content: tool.content.filter((item) => item.type === 'diff') }, context, { stopped: true })[0]!;

/** The tool title for the status line's "Running …". */
export const shortToolTitle = (tool: ToolCall, context: PathContext, maxWidth = 40): string => {
  const command = tool.kind === 'execute' ? commandTitle(tool.title, context) : undefined;
  if (tool.kind === 'execute') {
    // The command itself is on its own row; the status line names it by its first word.
    const word = command?.split(/\s+/)[0];
    return word ? fitLine([seg(word)], maxWidth).map((segment) => segment.text).join('') : 'a command';
  }
  const title = command === undefined ? tidyTitle(tool.title, context) : shortenPathsIn(command, context);
  return fitLine([seg(title)], maxWidth).map((segment) => segment.text).join('');
};

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

/** A notice, wrapped rather than cut: its end is often what to do about it. */
export const formatNotice = (level: 'info' | 'warning' | 'error', text: string, width: number): Line[] => {
  const body = oneLine(text);
  switch (level) {
    case 'info':
      return wrapMessage([seg('· ', 'muted')], body, { tone: 'muted' }, width);
    case 'warning':
      // A bold label, and the message in the default colour: yellow text is faint on light themes.
      return wrapMessage([seg('! ', 'warning', { bold: true })], body, {}, width);
    case 'error':
      return wrapMessage([seg('✗ ', 'error', { bold: true })], body, { tone: 'error' }, width);
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
  const question = fitLine([seg('? ', 'accent', { bold: true }), seg(`${context.agentName} wants to: `, undefined, { bold: true }), seg(title)], width);
  const labels = prompt.options.map(optionLabel);

  const option = (label: string, index: number): Segment[] => index === prompt.selected
    ? [seg('❯ ', 'accent', { bold: true }), seg(label, 'accent', { bold: true })]
    : [seg('  '), seg(label)];

  const across: Segment[] = [];
  labels.forEach((label, index) => across.push(seg(index === 0 ? '' : '  '), ...option(label, index)));
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
  if (ms < 1000) {
    return '<1s';
  }
  const seconds = Math.floor(ms / 1000);
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

/** A key hint on the status row. */
export interface StatusHint {
  readonly text: string;
  /** Used before the hint is dropped: `esc` for `esc background`. */
  readonly short?: string;
  /** Lower stays longer: when room runs out, the highest is shortened, then dropped. */
  readonly priority: number;
}

export interface StatusLineView {
  readonly phase: string;
  readonly elapsedMs: number;
  /** In the order they are shown. */
  readonly hints: readonly StatusHint[];
}

const HINT_SEPARATOR = ' · ';
/** Cells kept free at the right edge: an ambiguous-width glyph (←, →, ·) may take two in some terminals. */
const HINT_MARGIN = 1;
/** A hint shorter than this once ellipsized is not worth showing. */
const MIN_HINT_CELLS = 6;

/**
 * The hints that fit in `room` cells: the least important shortened first,
 * then dropped, and the last one left ellipsized if it still does not fit.
 */
export const fitHints = (hints: readonly StatusHint[], room: number): string => {
  let shown = hints.map((hint) => ({ ...hint, current: hint.text }));
  const text = (): string => shown.map((hint) => hint.current).join(HINT_SEPARATOR);
  // The least important first: shortened, then dropped, before the next is touched.
  for (const hint of [...shown].sort((a, b) => b.priority - a.priority)) {
    if (displayWidth(text()) <= room) {
      return text();
    }
    if (hint.short !== undefined) {
      hint.current = hint.short;
      if (displayWidth(text()) <= room) {
        return text();
      }
    }
    if (shown.length > 1) {
      shown = shown.filter((candidate) => candidate !== hint);
    }
  }
  if (displayWidth(text()) <= room) {
    return text();
  }
  return room >= MIN_HINT_CELLS ? truncateEnd(text(), room) : '';
};

/** The live status row: spinner, phase and time on the left, key hints on the right when they fit. */
export const formatStatus = (status: StatusLineView, context: FormatContext): Line => {
  const left: Line = [
    seg(context.spinner, 'accent'),
    seg(' '),
    seg(status.phase),
    seg(` · ${formatDuration(status.elapsedMs)}`, 'muted'),
  ];
  const hints = fitHints(status.hints, context.width - lineWidth(left) - 2 - HINT_MARGIN);
  return alignRight(left, hints ? [seg(hints, 'muted'), seg(' '.repeat(HINT_MARGIN))] : [], context.width);
};

export interface TurnOutcome {
  readonly stopReason: StopReason;
  readonly error: string | null;
  readonly durationMs: number;
}

export interface SummaryFacts {
  readonly toolCount: number;
  /** The turn showed something: text or a tool call. */
  readonly produced: boolean;
  /** It showed a notice (a warning about the empty reply, say). */
  readonly noticed: boolean;
}

/**
 * The rows a finished turn leaves behind. A failure wraps (its end is the
 * useful part), says how long it took, suggests a next step and leaves a
 * blank row before the prompt. A turn that showed nothing but a notice
 * leaves no footer at all.
 */
/** The name shown when no agent is known: a turn that failed before any agent ran (none is set up, say). */
export const UNKNOWN_AGENT = 'agent';

export const formatSummary = (outcome: TurnOutcome, facts: SummaryFacts, context: FormatContext): Line[] => {
  const time = formatDuration(outcome.durationMs);
  const agent = context.agentName;
  // Without an agent, there is no run to time and no agent to check: the message says it all.
  const ran = agent !== UNKNOWN_AGENT;
  const error = outcome.error ? oneLine(outcome.error) : undefined;
  const muted = (text: string): Line[] => wrapMessage([], text, { tone: 'muted' }, context.width);
  const hint = fitLine([seg(`  Try again, or check \`${agent}\` on its own.`, 'muted')], context.width);
  const failed = (text: string, withHint: boolean): Line[] => [
    ...wrapMessage([seg('✗ ', 'error', { bold: true })], ran ? `${text} · ${time}` : text, { tone: 'error' }, context.width),
    ...(withHint && ran ? [hint] : []),
    [],
  ];

  switch (outcome.stopReason) {
    case 'end_turn':
      if (!facts.produced) {
        return facts.noticed ? [] : muted(`◼ No reply · ${time}`);
      }
      return muted(`✓ ${time}${facts.toolCount > 0 ? ` · ${plural(facts.toolCount, 'tool')}` : ''}`);
    case 'cancelled':
      return muted(`◼ Stopped · ${time}`);
    case 'max_tokens':
      return muted(`◼ Stopped: ${agent} reached its output limit · ${time}`);
    case 'max_turn_requests':
      return muted(`◼ Stopped: ${agent} reached its step limit for one turn · ${time}`);
    case 'refusal':
      return failed(`${agent} declined to continue`, false);
    case 'interrupted':
      return failed(error ? `Interrupted: ${error}` : `Interrupted: ${agent} stopped unexpectedly`, true);
    case 'error':
      return failed(error ?? `${agent} failed`, true);
  }
};

/** Shown when the user sends a running turn to the background. */
export const formatBackgrounded = (context: FormatContext): Line =>
  fitLine([seg('↳ ', 'accent'), seg(`${context.agentName} is still working · `, 'muted'), seg('::', 'accent', { bold: true }), seg(' to check back', 'muted')], context.width);

/** The tail of `text` that fits in `width`, for previews. */
export const previewTail = (text: string, width: number): string => truncateStart(oneLine(text), width);
