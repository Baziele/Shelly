import * as Schema from 'effect/Schema';

/*
 * What the client and the daemon say to each other about agents, threads and
 * fast requests. Times are epoch milliseconds. Agent output is normalised
 * from ACP here, so clients never see an agent's own protocol.
 */

export { PROTOCOL_VERSION } from './version.js';

// ─── Agents ─────────────────────────────────────────────────────────────────

export const AgentInfo = Schema.Struct({
  /** Stable id used in config and threads: `claude`, `opencode`, or a custom name. */
  id: Schema.String,
  name: Schema.String,
  available: Schema.Boolean,
  /** Why it cannot be used right now, shown to the user (not installed, not signed in, …). */
  unavailableReason: Schema.NullOr(Schema.String),
  supportsFast: Schema.Boolean,
  isDefault: Schema.Boolean,
});
export type AgentInfo = typeof AgentInfo.Type;

// ─── Context the client sends with a request ────────────────────────────────

export const EnvironmentInfo = Schema.Struct({
  os: Schema.String,
  shell: Schema.String,
  shellVersion: Schema.NullOr(Schema.String),
  terminal: Schema.NullOr(Schema.String),
});
export type EnvironmentInfo = typeof EnvironmentInfo.Type;

/** One recorded shell command, cleaned and redacted by the client. */
export const ContextCommand = Schema.Struct({
  id: Schema.Number,
  command: Schema.String,
  cwd: Schema.NullOr(Schema.String),
  exitCode: Schema.NullOr(Schema.Number),
  durationMs: Schema.Number,
  /** The end of the output, where results and errors usually are. */
  output: Schema.String,
  omittedLines: Schema.Number,
  usedFullScreen: Schema.Boolean,
});
export type ContextCommand = typeof ContextCommand.Type;

export const PromptContext = Schema.Struct({
  /** The shell's working directory right now. */
  cwd: Schema.String,
  environment: EnvironmentInfo,
  /** Commands the agent has not heard about yet, oldest first. */
  commands: Schema.Array(ContextCommand),
});
export type PromptContext = typeof PromptContext.Type;

// ─── Threads ────────────────────────────────────────────────────────────────

/** `home`: Shelly's own folder (the default). `folder`: rooted where the user asked. */
export const ThreadLocation = Schema.Literals(['home', 'folder']);
export type ThreadLocation = typeof ThreadLocation.Type;

/** `waiting`: a turn is paused on a permission request. */
export const ThreadStatus = Schema.Literals(['idle', 'running', 'waiting']);
export type ThreadStatus = typeof ThreadStatus.Type;

export const ThreadSummary = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  agentId: Schema.String,
  location: ThreadLocation,
  /** The agent session's working directory. */
  cwd: Schema.String,
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
  status: ThreadStatus,
  turnCount: Schema.Number,
  /** The client currently driving the thread, if any. */
  attachedBy: Schema.NullOr(Schema.String),
});
export type ThreadSummary = typeof ThreadSummary.Type;

export const AgentMode = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  description: Schema.NullOr(Schema.String),
});
export type AgentMode = typeof AgentMode.Type;

export const ModeState = Schema.Struct({
  currentModeId: Schema.String,
  availableModes: Schema.Array(AgentMode),
});
export type ModeState = typeof ModeState.Type;

// ─── Thread events (what clients render) ────────────────────────────────────

export const ToolKind = Schema.Literals([
  'read', 'edit', 'delete', 'move', 'search', 'execute', 'think', 'fetch', 'switch_mode', 'other',
]);
export type ToolKind = typeof ToolKind.Type;

export const ToolStatus = Schema.Literals(['pending', 'in_progress', 'completed', 'failed']);
export type ToolStatus = typeof ToolStatus.Type;

export const ToolLocation = Schema.Struct({
  path: Schema.String,
  line: Schema.NullOr(Schema.Number),
});

/** Large text is cut by the daemon before it reaches a client; `truncated` says so. */
export const ToolContent = Schema.Union([
  Schema.Struct({ type: Schema.Literal('text'), text: Schema.String, truncated: Schema.Boolean }),
  Schema.Struct({
    type: Schema.Literal('diff'),
    path: Schema.String,
    /** Null for a new file. */
    oldText: Schema.NullOr(Schema.String),
    newText: Schema.String,
    truncated: Schema.Boolean,
  }),
]);
export type ToolContent = typeof ToolContent.Type;

/** The whole current state of one tool call; each update replaces the last. */
export const ToolCall = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  kind: ToolKind,
  status: ToolStatus,
  locations: Schema.Array(ToolLocation),
  content: Schema.Array(ToolContent),
});
export type ToolCall = typeof ToolCall.Type;

export const PlanEntry = Schema.Struct({
  content: Schema.String,
  priority: Schema.Literals(['high', 'medium', 'low']),
  status: Schema.Literals(['pending', 'in_progress', 'completed']),
});
export type PlanEntry = typeof PlanEntry.Type;

export const PermissionOption = Schema.Struct({
  optionId: Schema.String,
  name: Schema.String,
  kind: Schema.Literals(['allow_once', 'allow_always', 'reject_once', 'reject_always']),
});
export type PermissionOption = typeof PermissionOption.Type;

export const StopReason = Schema.Literals([
  'end_turn',
  'max_tokens',
  'max_turn_requests',
  'refusal',
  'cancelled',
  /** The agent or its process failed; `error` says how. */
  'error',
  /** The daemon lost the turn (it restarted, or the agent process died). */
  'interrupted',
]);
export type StopReason = typeof StopReason.Type;

const eventFields = {
  /** Per thread, strictly increasing, starting at 1. */
  seq: Schema.Number,
};

export const TurnStarted = Schema.Struct({
  ...eventFields,
  type: Schema.Literal('turn.started'),
  turnId: Schema.String,
  /** What the user typed, without the context Shelly added. */
  text: Schema.String,
  at: Schema.Number,
  /**
   * The `clientRequestId` of the `thread.prompt` that started the turn, as
   * the client sent it: a client that lost its stream before this event
   * finds its own turn by it, never another one with the same text. Absent
   * when the prompt had none. Added without a protocol version bump: both
   * sides take it as optional, and ignore it if they do not know it.
   */
  clientRequestId: Schema.optionalKey(Schema.String),
});

/**
 * Streamed text. Chunks with the same `messageId` belong to one message;
 * a new id starts a new message (for example after a tool call). A chunk
 * adds to the message's text, unless it carries `replace`.
 */
export const MessageChunk = Schema.Struct({
  ...eventFields,
  type: Schema.Literal('message.chunk'),
  turnId: Schema.String,
  messageId: Schema.String,
  /** `thought`: the agent's visible reasoning. */
  kind: Schema.Literals(['text', 'thought']),
  text: Schema.String,
  /**
   * true: `text` is the message's whole text so far; replace whatever the
   * client has for this `messageId` instead of adding to it. Set on stored
   * chunks merged after their turn ended (replayed by `thread.watch` and in
   * history), which can reach a client that already saw some of the
   * message. Absent on live chunks. Added without a protocol version bump:
   * a client that ignores it only repeats text in that one case.
   */
  replace: Schema.optionalKey(Schema.Boolean),
});

export const ToolUpdated = Schema.Struct({
  ...eventFields,
  type: Schema.Literal('tool.updated'),
  turnId: Schema.String,
  tool: ToolCall,
});

export const PlanUpdated = Schema.Struct({
  ...eventFields,
  type: Schema.Literal('plan.updated'),
  turnId: Schema.String,
  entries: Schema.Array(PlanEntry),
});

export const PermissionRequested = Schema.Struct({
  ...eventFields,
  type: Schema.Literal('permission.requested'),
  turnId: Schema.String,
  requestId: Schema.String,
  /** The tool call asking, when there is one; its latest state is also sent as `tool.updated`. */
  toolCallId: Schema.NullOr(Schema.String),
  title: Schema.String,
  options: Schema.Array(PermissionOption),
});

export const PermissionResolved = Schema.Struct({
  ...eventFields,
  type: Schema.Literal('permission.resolved'),
  turnId: Schema.String,
  requestId: Schema.String,
  /** Null when the request was cancelled (the turn was stopped). */
  optionId: Schema.NullOr(Schema.String),
});

export const ModeChanged = Schema.Struct({
  ...eventFields,
  type: Schema.Literal('mode.changed'),
  currentModeId: Schema.String,
  availableModes: Schema.Array(AgentMode),
});

export const Notice = Schema.Struct({
  ...eventFields,
  type: Schema.Literal('notice'),
  turnId: Schema.NullOr(Schema.String),
  level: Schema.Literals(['info', 'warning', 'error']),
  text: Schema.String,
});

export const TurnEnded = Schema.Struct({
  ...eventFields,
  type: Schema.Literal('turn.ended'),
  turnId: Schema.String,
  stopReason: StopReason,
  error: Schema.NullOr(Schema.String),
  durationMs: Schema.Number,
});

export const ThreadEvent = Schema.Union([
  TurnStarted,
  MessageChunk,
  ToolUpdated,
  PlanUpdated,
  PermissionRequested,
  PermissionResolved,
  ModeChanged,
  Notice,
  TurnEnded,
]);
export type ThreadEvent = typeof ThreadEvent.Type;
export type ThreadEventOf<T extends ThreadEvent['type']> = Extract<ThreadEvent, { type: T }>;

// ─── Fast mode ──────────────────────────────────────────────────────────────

export const FastInput = Schema.Struct({
  /** What the user asked for. */
  instruction: Schema.String,
  /** The command line the user was editing, if they started from one. */
  buffer: Schema.String,
  cwd: Schema.String,
  environment: EnvironmentInfo,
  /** The last command or two, for "fix that" style requests. */
  recentCommands: Schema.Array(ContextCommand),
});
export type FastInput = typeof FastInput.Type;

export const FastEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal('delta'), text: Schema.String }),
  Schema.Struct({
    type: Schema.Literal('done'),
    /** The full reply. For a command: the command alone, ready for the input line. */
    text: Schema.String,
    kind: Schema.Literals(['command', 'answer']),
    durationMs: Schema.Number,
  }),
]);
export type FastEvent = typeof FastEvent.Type;
