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

/** One file of a git patch: its paths and the text of its hunks on each side. */
interface PatchFile {
  oldPath: string | null;
  newPath: string | null;
  oldLines: string[];
  newLines: string[];
  hunks: number;
}

const patchPath = (raw: string): string | null => {
  const path = raw.trim().replace(/\t.*$/, '');
  if (path === '/dev/null') {
    return null;
  }
  // Git's own `a/` and `b/` prefixes; claude-agent-acp writes absolute paths without them.
  return /^[ab]\//.test(path) && !path.startsWith('/') ? path.slice(2) : path;
};

/**
 * The files of a unified git patch, each hunk's context and changed lines
 * gathered per side. Hunks of one file are joined, so a diff of the two sides
 * shows the same changes (the context between hunks is not in the patch).
 */
export const parsePatch = (text: string): PatchFile[] => {
  const files: PatchFile[] = [];
  let file: PatchFile | null = null;
  let inHunk = false;
  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      file = { oldPath: null, newPath: null, oldLines: [], newLines: [], hunks: 0 };
      files.push(file);
      inHunk = false;
      continue;
    }
    if (!file) {
      continue;
    }
    if (!inHunk && line.startsWith('--- ')) {
      file.oldPath = patchPath(line.slice(4));
    } else if (!inHunk && line.startsWith('+++ ')) {
      file.newPath = patchPath(line.slice(4));
    } else if (line.startsWith('@@')) {
      inHunk = true;
      file.hunks++;
    } else if (inHunk) {
      if (line.startsWith('+')) {
        file.newLines.push(line.slice(1));
      } else if (line.startsWith('-')) {
        file.oldLines.push(line.slice(1));
      } else if (line.startsWith(' ')) {
        file.oldLines.push(line.slice(1));
        file.newLines.push(line.slice(1));
      }
      // `\ No newline at end of file` and anything else carry no text.
    }
  }
  return files;
};

type V2Diff = Extract<Acp.ToolCallContent, { readonly type: 'diff'; readonly changes: unknown }>;

/**
 * ACP v2's diff (Claude Code negotiates v2 with Shelly's client): `changes`
 * say which files and how, the git `patch` holds the text. Each file becomes
 * an ordinary diff; a new file has no old text.
 */
const mapV2Diff = (content: V2Diff): ToolContent[] => {
  const patch = content.patch as { readonly text?: unknown } | null | undefined;
  const files = typeof patch?.text === 'string' ? parsePatch(patch.text) : [];
  const changes = content.changes as readonly { readonly operation?: string; readonly path?: string; readonly oldPath?: string }[];
  const diffs: ToolContent[] = files.flatMap((file, index) => {
    const change = changes[index];
    const path = file.newPath ?? file.oldPath ?? change?.path;
    if (path === undefined || file.hunks === 0) {
      return [];
    }
    const created = file.oldPath === null || change?.operation === 'add';
    const cut = truncateDiff(created ? null : file.oldLines.join('\n'), file.newLines.join('\n'));
    return [{ type: 'diff' as const, path, ...cut }];
  });
  if (diffs.length > 0) {
    return diffs;
  }
  // No patch to show (a rename, a binary file): say what changed.
  const described = changes.flatMap((change) => {
    if (typeof change.path !== 'string') {
      return [];
    }
    switch (change.operation) {
      case 'add':
        return [`Created ${change.path}`];
      case 'delete':
        return [`Deleted ${change.path}`];
      case 'move':
        return [`Moved ${change.oldPath ?? '?'} to ${change.path}`];
      default:
        return [`Changed ${change.path}`];
    }
  });
  return described.length > 0 ? [{ type: 'text', text: described.join('\n'), truncated: false }] : [];
};

export const mapToolContent = (content: Acp.ToolCallContent): ToolContent[] => {
  switch (content.type) {
    case 'content': {
      const text = blockText(content.content);
      return text === null ? [] : [{ type: 'text', ...truncateText(text) }];
    }
    case 'diff': {
      if (!('path' in content)) {
        return mapV2Diff(content);
      }
      const cut = truncateDiff(content.oldText ?? null, content.newText);
      return [{ type: 'diff', path: content.path, ...cut }];
    }
    default:
      // `terminal` placeholders: their output comes separately (see the tool tracker).
      return [];
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
 * Command output. The tool call's own content holds only a `terminal`
 * placeholder; the output comes separately, and the tracker shows it as the
 * tool's last text content. Two forms, one per ACP generation:
 *
 * - v1 (OpenCode never sends it; Claude Code would with a v1 client): the
 *   tool call's `_meta`, because Shelly advertises `terminal_output_delta`:
 *   `terminal_info` (a terminal starts), `terminal_output_delta` (append),
 *   `terminal_output` (the whole output so far) and `terminal_exit`
 *   (`exit_code`, `signal`), each with a `terminal_id`.
 * - v2 (what Claude Code negotiates with Shelly's client): session updates
 *   `terminal_update` (`output` replaces, `exitStatus`) and
 *   `terminal_output_chunk` (appends), both base64, for the terminal that
 *   the tool's `terminal` content names. They can arrive before the tool call.
 *
 * The output is untrusted terminal text: it goes to clients, which sanitise
 * it before drawing, and is never logged.
 */

/** Output kept per command while it runs: enough for the 8 KB shown, with room for an exit line. */
const MAX_TERMINAL_BUFFER_CHARS = 2 * MAX_TOOL_TEXT_CHARS;

export interface TerminalState {
  output: string;
  /** Output was dropped from the start to bound the buffer. */
  dropped: boolean;
  exit: { readonly code: number | null; readonly signal: string | null } | null;
}

/** A change to a terminal: output that replaces or follows what it showed, and how it exited. */
export interface TerminalChange {
  readonly replace?: string | undefined;
  readonly append?: string | undefined;
  readonly exit?: { readonly code: number | null; readonly signal: string | null } | undefined;
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

const terminalData = (value: unknown): string | undefined => {
  const data = record(value)?.data;
  return typeof data === 'string' ? data : undefined;
};

const applyTerminalChange = (previous: TerminalState | undefined, change: TerminalChange): TerminalState => {
  const next: TerminalState = previous ? { ...previous } : { output: '', dropped: false, exit: null };
  if (change.replace !== undefined) {
    next.output = change.replace;
    next.dropped = false;
  }
  if (change.append !== undefined) {
    next.output += change.append;
  }
  if (next.output.length > MAX_TERMINAL_BUFFER_CHARS) {
    next.output = next.output.slice(next.output.length - MAX_TERMINAL_BUFFER_CHARS);
    next.dropped = true;
  }
  if (change.exit) {
    next.exit = change.exit;
  }
  return next;
};

const TERMINAL_META_KEYS = ['terminal_info', 'terminal_output', 'terminal_output_delta', 'terminal_exit'] as const;

/** A v1 tool call's `_meta` terminal fields, with the terminal they name; undefined if it has none. */
const terminalMeta = (meta: unknown): { readonly terminalId: string | undefined; readonly change: TerminalChange } | undefined => {
  const fields = record(meta);
  if (!fields || !TERMINAL_META_KEYS.some((key) => key in fields)) {
    return undefined;
  }
  const terminalId = TERMINAL_META_KEYS
    .map((key) => record(fields[key])?.terminal_id)
    .find((id): id is string => typeof id === 'string');
  const exit = record(fields.terminal_exit);
  return {
    terminalId,
    change: {
      replace: terminalData(fields.terminal_output),
      append: terminalData(fields.terminal_output_delta),
      exit: exit && {
        code: typeof exit.exit_code === 'number' ? exit.exit_code : null,
        signal: typeof exit.signal === 'string' ? exit.signal : null,
      },
    },
  };
};

/** Base64 terminal bytes as text (ACP v2). */
export const decodeTerminalData = (data: unknown): string | undefined =>
  typeof data === 'string' ? Buffer.from(data, 'base64').toString('utf8') : undefined;

/**
 * The command's output as tool text: its end, with the exit status of a
 * failed command as the last line (Claude Code puts its own "Exit code N"
 * first, where a short preview would never show it).
 */
export const terminalText = (terminal: TerminalState): Extract<ToolContent, { type: 'text' }> | null => {
  // Output read from a pty ends its lines with CRLF.
  let output = terminal.output.replace(/\r\n/g, '\n');
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

/** OpenCode's write result: "Created" for a new file, "Wrote" for an existing one. */
const CREATED_FILE = /^Created file successfully: (.+)$/m;

/**
 * A new-file diff for a write that sent no diff but says it created the file
 * (OpenCode, when it doesn't ask permission first): the written text is in
 * its raw input. Only for a creation: an overwrite has old text nobody sent,
 * and a diff without it would claim a new file.
 */
const createdFileDiff = (
  content: readonly ToolContent[],
  rawInput: unknown,
  locations: readonly { readonly path: string }[],
): ToolContent | undefined => {
  const created = content
    .flatMap((item) => (item.type === 'text' ? [CREATED_FILE.exec(item.text)] : []))
    .find((match) => match !== null);
  const input = record(rawInput);
  const text = input?.content ?? input?.file_text ?? input?.file_content;
  if (!created || typeof text !== 'string') {
    return undefined;
  }
  const path = locations[0]?.path ?? created[1]!.trim();
  return { type: 'diff', path, ...truncateDiff(null, text) };
};

/**
 * Merges `tool_call` and `tool_call_update` into each call's whole state.
 * ACP updates carry only the fields that changed; `content` and `locations`
 * replace the previous lists when present. Command output (see above) is
 * kept by terminal and shown after the content.
 */
export class ToolTracker {
  readonly #tools = new Map<string, {
    readonly call: ToolCall;
    readonly content: readonly ToolContent[];
    readonly rawInput: unknown;
  }>();
  readonly #terminals = new Map<string, TerminalState>();
  readonly #terminalOfTool = new Map<string, string>();

  apply(update: Acp.ToolCallUpdate, replace = false): ToolCall {
    const id = update.toolCallId;
    const previous = replace ? undefined : this.#tools.get(id);
    const status = update.status && TOOL_STATUSES.has(update.status) ? update.status as ToolStatus : undefined;
    const rawInput = update.rawInput ?? previous?.rawInput;
    let content = update.content
      ? update.content.flatMap((item) => mapToolContent(item))
      : previous?.content ?? [];
    // What a tool changed stays shown: a later result message doesn't take it back
    // (OpenCode replaces its permission request's diff with "Created file …").
    const earlierDiffs = (previous?.content ?? []).filter((item) => item.type === 'diff');
    if (!content.some((item) => item.type === 'diff') && earlierDiffs.length > 0) {
      content = [...earlierDiffs, ...content];
    }
    const kind = update.kind ? mapToolKind(update.kind) : previous?.call.kind ?? 'other';
    const locations = update.locations
      ? update.locations.map((location) => ({ path: location.path, line: location.line ?? null }))
      : previous?.call.locations ?? [];
    if (kind === 'edit' && !content.some((item) => item.type === 'diff')) {
      const created = createdFileDiff(content, rawInput, locations);
      if (created) {
        content = [created, ...content];
      }
    }
    for (const item of update.content ?? []) {
      if (item.type === 'terminal') {
        this.#terminalOfTool.set(id, item.terminalId);
      }
    }
    const meta = terminalMeta(update._meta);
    if (meta) {
      const terminalId = meta.terminalId ?? this.#terminalOfTool.get(id) ?? id;
      this.#terminalOfTool.set(id, terminalId);
      this.#terminals.set(terminalId, applyTerminalChange(this.#terminals.get(terminalId), meta.change));
    }
    const call: ToolCall = {
      id,
      title: update.title ?? previous?.call.title ?? update.name ?? 'Tool',
      kind,
      status: status ?? previous?.call.status ?? 'pending',
      locations,
      content,
    };
    this.#tools.set(id, { call, content, rawInput });
    return this.#shown(id)!;
  }

  /** A v2 terminal update; returns the tool that shows the terminal, if one does yet. */
  applyTerminal(terminalId: string, change: TerminalChange): ToolCall | undefined {
    this.#terminals.set(terminalId, applyTerminalChange(this.#terminals.get(terminalId), change));
    for (const [toolId, shown] of this.#terminalOfTool) {
      if (shown === terminalId) {
        return this.#shown(toolId);
      }
    }
    return undefined;
  }

  get(id: string): ToolCall | undefined {
    return this.#shown(id);
  }

  /** The tool with its terminal's output after its content. */
  #shown(id: string): ToolCall | undefined {
    const entry = this.#tools.get(id);
    if (!entry) {
      return undefined;
    }
    const terminalId = this.#terminalOfTool.get(id);
    const terminal = terminalId === undefined ? undefined : this.#terminals.get(terminalId);
    const output = terminal ? terminalText(terminal) : null;
    return output ? { ...entry.call, content: [...entry.content, output] } : entry.call;
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
    case 'terminal_update': {
      const exit = update.exitStatus;
      const tool = tools.applyTerminal(update.terminalId, {
        replace: decodeTerminalData(update.output?.data),
        exit: exit ? { code: exit.exitCode ?? null, signal: exit.signal ?? null } : undefined,
      });
      return tool ? { kind: 'update', update: { type: 'tool', tool } } : IGNORE;
    }
    case 'terminal_output_chunk': {
      const tool = tools.applyTerminal(update.terminalId, { append: decodeTerminalData(update.data) });
      return tool ? { kind: 'update', update: { type: 'tool', tool } } : IGNORE;
    }
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
