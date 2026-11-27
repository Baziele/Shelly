import type * as Acp from '../../acp/compat.js';
import type {
  AgentMode,
  PermissionOption,
  PlanEntry,
  StopReason,
  ToolCall,
  ToolContent,
  ToolKind,
  ToolStatus,
} from '../../protocol/schema.js';
import type { AgentUpdate } from '../services.js';

/*
 * Pure translation from ACP (as the vendored client normalises it) to
 * Shelly's AgentUpdate. No Effect, no state beyond the tool tracker, so it is
 * easy to test against recorded traffic.
 */

// ─── Truncation ─────────────────────────────────────────────────────────────

/** Tool text keeps its end (where results and errors are), about 8 KB. */
export const MAX_TOOL_TEXT_CHARS = 8 * 1024;
/** Each side of a diff keeps about this many lines. */
export const MAX_DIFF_LINES = 200;
/** And at most this many characters, for diffs of minified files. */
export const MAX_DIFF_SIDE_CHARS = 64 * 1024;
const DIFF_CONTEXT_LINES = 3;

export const truncateText = (text: string, max = MAX_TOOL_TEXT_CHARS): { text: string; truncated: boolean } =>
  text.length <= max ? { text, truncated: false } : { text: text.slice(text.length - max), truncated: true };

const splitLines = (text: string): string[] => text.split('\n');

/**
 * Cuts a large diff down to the changed region: drops the lines both sides
 * share at the start and end (keeping a little context), then caps each side.
 * Dropping the same lines from both sides keeps the diff itself intact.
 */
export const truncateDiff = (
  oldText: string | null,
  newText: string,
  maxLines = MAX_DIFF_LINES,
): { oldText: string | null; newText: string; truncated: boolean } => {
  const oldLines = oldText === null ? [] : splitLines(oldText);
  const newLines = splitLines(newText);
  const fits = (lines: readonly string[], text: string | null) =>
    lines.length <= maxLines && (text?.length ?? 0) <= MAX_DIFF_SIDE_CHARS;
  if (fits(oldLines, oldText) && fits(newLines, newText)) {
    return { oldText, newText, truncated: false };
  }
  let start = 0;
  if (oldText !== null) {
    while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) {
      start++;
    }
  }
  let end = 0;
  if (oldText !== null) {
    while (
      end < oldLines.length - start && end < newLines.length - start
      && oldLines[oldLines.length - 1 - end] === newLines[newLines.length - 1 - end]
    ) {
      end++;
    }
  }
  const from = Math.max(0, start - DIFF_CONTEXT_LINES);
  const keepEnd = Math.max(0, end - DIFF_CONTEXT_LINES);
  const cut = (lines: readonly string[]): string => {
    const region = lines.slice(from, lines.length - keepEnd).slice(0, maxLines).join('\n');
    return region.length <= MAX_DIFF_SIDE_CHARS ? region : region.slice(0, MAX_DIFF_SIDE_CHARS);
  };
  return { oldText: oldText === null ? null : cut(oldLines), newText: cut(newLines), truncated: true };
};

// ─── Content ────────────────────────────────────────────────────────────────

/** The text of a content block, or null for blocks Shelly doesn't show (images, audio). */
export const blockText = (block: Acp.ContentBlock): string | null => {
  switch (block.type) {
    case 'text':
      return block.text;
    case 'resource':
      return 'text' in block.resource ? block.resource.text : null;
    case 'resource_link':
      return block.uri;
    default:
      return null;
  }
};

export const mapToolContent = (content: Acp.ToolCallContent): ToolContent | null => {
  switch (content.type) {
    case 'content': {
      const text = blockText(content.content);
      return text === null ? null : { type: 'text', ...truncateText(text) };
    }
    case 'diff': {
      if (!('path' in content)) {
        // ACP v2's structured diff (`changes`, `patch`): show the patch text when there is one.
        const patch = content.patch as { readonly text?: unknown } | null | undefined;
        return typeof patch?.text === 'string' ? { type: 'text', ...truncateText(patch.text) } : null;
      }
      const cut = truncateDiff(content.oldText ?? null, content.newText);
      return { type: 'diff', path: content.path, ...cut };
    }
    default:
      // Client terminals: Shelly doesn't advertise the capability, so agents don't send them.
      return null;
  }
};

const TOOL_KINDS: ReadonlySet<string> = new Set<ToolKind>([
  'read', 'edit', 'delete', 'move', 'search', 'execute', 'think', 'fetch', 'switch_mode', 'other',
]);
const TOOL_STATUSES: ReadonlySet<string> = new Set<ToolStatus>(['pending', 'in_progress', 'completed', 'failed']);

export const mapToolKind = (kind: string | null | undefined): ToolKind =>
  kind && TOOL_KINDS.has(kind) ? kind as ToolKind : 'other';

// ─── Tool calls ─────────────────────────────────────────────────────────────

/*
 * Command output. Shelly advertises `_meta.terminal_output_delta` (see
 * process.ts), so claude-agent-acp reports a shell command's output in its
 * tool call's `_meta`, keyed by `terminal_id` (the tool call id):
 * `terminal_info` (a terminal starts), `terminal_output_delta` (append),
 * `terminal_output` (the whole output so far, replacing it) and
 * `terminal_exit` (`exit_code`, `signal`). The tool call's own content then
 * holds only a `terminal` placeholder, which Shelly can't show. The tracker
 * turns that output into the tool's last text content instead.
 *
 * The output is untrusted terminal text: it goes to clients, which sanitise
 * it before drawing, and is never logged.
 */

/** Output kept per command while it runs: enough for the 8 KB shown, with room for an exit line. */
const MAX_TERMINAL_BUFFER_CHARS = 2 * MAX_TOOL_TEXT_CHARS;

interface TerminalState {
  output: string;
  /** Output was dropped from the start to bound the buffer. */
  dropped: boolean;
  exit: { readonly code: number | null; readonly signal: string | null } | null;
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

const terminalData = (value: unknown): string | undefined => {
  const data = record(value)?.data;
  return typeof data === 'string' ? data : undefined;
};

/** Applies a tool call's `_meta` terminal fields; returns the new state, or the old one if it has none. */
const applyTerminalMeta = (meta: unknown, previous: TerminalState | undefined): TerminalState | undefined => {
  const fields = record(meta);
  if (!fields || !('terminal_info' in fields || 'terminal_output' in fields
    || 'terminal_output_delta' in fields || 'terminal_exit' in fields)) {
    return previous;
  }
  const next: TerminalState = previous ? { ...previous } : { output: '', dropped: false, exit: null };
  const whole = terminalData(fields.terminal_output);
  if (whole !== undefined) {
    next.output = whole;
    next.dropped = false;
  }
  const delta = terminalData(fields.terminal_output_delta);
  if (delta !== undefined) {
    next.output += delta;
  }
  if (next.output.length > MAX_TERMINAL_BUFFER_CHARS) {
    next.output = next.output.slice(next.output.length - MAX_TERMINAL_BUFFER_CHARS);
    next.dropped = true;
  }
  const exit = record(fields.terminal_exit);
  if (exit) {
    next.exit = {
      code: typeof exit.exit_code === 'number' ? exit.exit_code : null,
      signal: typeof exit.signal === 'string' ? exit.signal : null,
    };
  }
  return next;
};

/**
 * The command's output as tool text: its end, with the exit status of a
 * failed command as the last line (Claude Code puts its own "Exit code N"
 * first, where a short preview would never show it).
 */
export const terminalText = (terminal: TerminalState): Extract<ToolContent, { type: 'text' }> | null => {
  let output = terminal.output;
  const { code, signal } = terminal.exit ?? { code: null, signal: null };
  let status: string | null = null;
  if (signal !== null) {
    status = `Killed by ${signal}`;
  } else if (code !== null && code !== 0) {
    status = `Exit code ${code}`;
    if (output.startsWith(`${status}\n`)) {
      output = output.slice(status.length + 1);
    } else if (output === status) {
      output = '';
    }
  }
  output = output.replace(/\n+$/, '');
  const text = [output, status].filter((part): part is string => part !== null && part !== '').join('\n');
  if (text === '') {
    return null;
  }
  const cut = truncateText(text);
  return { type: 'text', text: cut.text, truncated: cut.truncated || terminal.dropped };
};

/**
 * Merges `tool_call` and `tool_call_update` into each call's whole state.
 * ACP updates carry only the fields that changed; `content` and `locations`
 * replace the previous lists when present. Command output (see above) is
 * kept apart and shown after the content.
 */
export class ToolTracker {
  readonly #tools = new Map<string, { readonly call: ToolCall; readonly content: readonly ToolContent[]; readonly terminal: TerminalState | undefined }>();

  apply(update: Acp.ToolCallUpdate, replace = false): ToolCall {
    const previous = replace ? undefined : this.#tools.get(update.toolCallId);
    const status = update.status && TOOL_STATUSES.has(update.status) ? update.status as ToolStatus : undefined;
    const content = update.content
      ? update.content.flatMap((item) => mapToolContent(item) ?? [])
      : previous?.content ?? [];
    const terminal = applyTerminalMeta(update._meta, previous?.terminal);
    const output = terminal ? terminalText(terminal) : null;
    const call: ToolCall = {
      id: update.toolCallId,
      title: update.title ?? previous?.call.title ?? update.name ?? 'Tool',
      kind: update.kind ? mapToolKind(update.kind) : previous?.call.kind ?? 'other',
      status: status ?? previous?.call.status ?? 'pending',
      locations: update.locations
        ? update.locations.map((location) => ({ path: location.path, line: location.line ?? null }))
        : previous?.call.locations ?? [],
      content: output ? [...content, output] : content,
    };
    this.#tools.set(call.id, { call, content, terminal });
    return call;
  }

  get(id: string): ToolCall | undefined {
    return this.#tools.get(id)?.call;
  }
}

// ─── Plans, modes, permissions ──────────────────────────────────────────────

const PRIORITIES = new Set(['high', 'medium', 'low']);
const PLAN_STATUSES = new Set(['pending', 'in_progress', 'completed']);

interface PlanEntryLike {
  readonly content: string;
  readonly priority: string;
  readonly status: string;
}

export const mapPlanEntries = (entries: readonly PlanEntryLike[]): PlanEntry[] =>
  entries.map((entry) => ({
    content: entry.content,
    priority: PRIORITIES.has(entry.priority) ? entry.priority as PlanEntry['priority'] : 'medium',
    status: PLAN_STATUSES.has(entry.status) ? entry.status as PlanEntry['status'] : 'pending',
  }));

export interface ModeState {
  readonly currentModeId: string;
  readonly availableModes: readonly AgentMode[];
}

/**
 * Where an agent's modes come from: ACP `modes` (claude-agent-acp), or a
 * select config option for the mode (OpenCode has only that, with its agents
 * as the choices). Either way Shelly shows them as modes.
 */
export type ModeSource =
  | { readonly kind: 'modes' }
  | { readonly kind: 'config'; readonly configId: string }
  | { readonly kind: 'none' };

const flattenSelectOptions = (options: Acp.SessionConfigSelectOptions): Acp.SessionConfigSelectOption[] =>
  options.flatMap((option) => 'options' in option ? [...option.options] : [option as Acp.SessionConfigSelectOption]);

/** The mode config option: id `mode`, or category `mode`. */
export const modeConfigOption = (
  configOptions: readonly Acp.SessionConfigOption[] | null | undefined,
): Extract<Acp.SessionConfigOption, { readonly type: 'select' }> | undefined => {
  const selects = (configOptions ?? []).filter(
    (option): option is Extract<Acp.SessionConfigOption, { readonly type: 'select' }> => option.type === 'select',
  );
  return selects.find((option) => option.id === 'mode') ?? selects.find((option) => option.category === 'mode');
};

export const modesFromConfigOption = (option: Extract<Acp.SessionConfigOption, { readonly type: 'select' }>): ModeState => ({
  currentModeId: option.currentValue,
  availableModes: flattenSelectOptions(option.options).map((choice) => ({
    id: choice.value,
    name: choice.name,
    description: choice.description ?? null,
  })),
});

export const modesFromSession = (response: {
  readonly modes?: Acp.SessionModeState | null;
  readonly configOptions?: readonly Acp.SessionConfigOption[] | null;
}): { readonly source: ModeSource; readonly state: ModeState | null } => {
  if (response.modes) {
    return {
      source: { kind: 'modes' },
      state: {
        currentModeId: response.modes.currentModeId,
        availableModes: response.modes.availableModes.map((mode) => ({
          id: mode.id,
          name: mode.name,
          description: mode.description ?? null,
        })),
      },
    };
  }
  const option = modeConfigOption(response.configOptions);
  return option
    ? { source: { kind: 'config', configId: option.id }, state: modesFromConfigOption(option) }
    : { source: { kind: 'none' }, state: null };
};

export const sameModes = (a: ModeState | null, b: ModeState | null): boolean =>
  a === b || (a !== null && b !== null && a.currentModeId === b.currentModeId
    && a.availableModes.length === b.availableModes.length
    && a.availableModes.every((mode, i) => mode.id === b.availableModes[i]?.id && mode.name === b.availableModes[i]?.name));

const PERMISSION_KINDS = new Set(['allow_once', 'allow_always', 'reject_once', 'reject_always']);

/** The agent's options as they are; a kind newer than Shelly's schema maps to the closest one it knows. */
export const mapPermissionOptions = (options: readonly Acp.PermissionOption[]): PermissionOption[] =>
  options.map((option) => ({
    optionId: option.optionId,
    name: option.name,
    kind: PERMISSION_KINDS.has(option.kind)
      ? option.kind as PermissionOption['kind']
      : String(option.kind).startsWith('reject') ? 'reject_once' : 'allow_once',
  }));

const STOP_REASONS = new Set(['end_turn', 'max_tokens', 'max_turn_requests', 'refusal', 'cancelled']);

export const mapStopReason = (stopReason: string): StopReason =>
  STOP_REASONS.has(stopReason) ? stopReason as StopReason : 'end_turn';

// ─── Session updates ────────────────────────────────────────────────────────

/** What one session/update means for a turn. Mode changes need the session's state, so the runtime finishes them. */
export type MappedUpdate =
  | { readonly kind: 'update'; readonly update: AgentUpdate }
  | { readonly kind: 'mode'; readonly currentModeId: string }
  | { readonly kind: 'config'; readonly configOptions: readonly Acp.SessionConfigOption[] }
  | { readonly kind: 'ignore' };

const IGNORE: MappedUpdate = { kind: 'ignore' };

export const mapSessionUpdate = (update: Acp.SessionUpdate, tools: ToolTracker): MappedUpdate => {
  switch (update.sessionUpdate) {
    case 'agent_message_chunk':
    case 'agent_thought_chunk': {
      const text = blockText(update.content);
      return text === null || text === ''
        ? IGNORE
        : {
          kind: 'update',
          update: { type: 'chunk', kind: update.sessionUpdate === 'agent_message_chunk' ? 'text' : 'thought', text },
        };
    }
    case 'tool_call':
      return { kind: 'update', update: { type: 'tool', tool: tools.apply(update) } };
    case 'tool_call_update':
      return { kind: 'update', update: { type: 'tool', tool: tools.apply(update) } };
    case 'plan':
      return { kind: 'update', update: { type: 'plan', entries: mapPlanEntries(update.entries) } };
    case 'plan_update':
      // v2 plans: `items` carry entries; a `file` plan lives elsewhere.
      return update.plan.type === 'items' && Array.isArray(update.plan.entries)
        ? { kind: 'update', update: { type: 'plan', entries: mapPlanEntries(update.plan.entries as readonly PlanEntryLike[]) } }
        : IGNORE;
    case 'plan_removed':
      return { kind: 'update', update: { type: 'plan', entries: [] } };
    case 'current_mode_update':
      return { kind: 'mode', currentModeId: update.currentModeId };
    case 'config_option_update':
      return { kind: 'config', configOptions: update.configOptions };
    case 'session_info_update':
      return typeof update.title === 'string' && update.title.trim() !== ''
        ? { kind: 'update', update: { type: 'title', title: update.title.trim() } }
        : IGNORE;
    case 'notice': {
      const level = update.severity === 'error' ? 'error' : update.severity === 'warning' ? 'warning' : 'info';
      const text = update.description ? `${update.title}: ${update.description}` : update.title;
      return { kind: 'update', update: { type: 'notice', level, text } };
    }
    default:
      // user_message_chunk (our own prompt, or a replay), available_commands_update,
      // usage_update, state_update, and anything newer than this client.
      return IGNORE;
  }
};
