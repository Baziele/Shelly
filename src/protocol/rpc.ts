import * as Rpc from 'effect/rpc/Rpc';
import * as RpcGroup from 'effect/rpc/RpcGroup';
import * as Schema from 'effect/Schema';
import {
  AgentFailed,
  AgentUnavailable,
  FastError,
  PromptError,
  ProtocolMismatch,
  ThreadError,
  ThreadNotFound,
  UnknownRequest,
} from './errors.js';
import {
  AgentInfo,
  FastEvent,
  FastInput,
  PromptContext,
  ThreadEvent,
  ThreadLocation,
  ThreadSummary,
} from './schema.js';

/*
 * The daemon's RPC surface. One client per terminal tab connects over the
 * unix socket; `clientId` identifies that tab for as long as it runs.
 *
 * Streams end on their own when there is nothing more to say (a turn ended,
 * a fast reply finished). A client that stops listening to a turn's stream,
 * or disconnects, does not stop the turn: use `thread.cancel` for that.
 */

/** The first call on every connection. */
export const Hello = Rpc.make('hello', {
  payload: {
    protocolVersion: Schema.Number,
    clientVersion: Schema.String,
    clientId: Schema.String,
    pid: Schema.Number,
  },
  success: Schema.Struct({
    protocolVersion: Schema.Number,
    daemonVersion: Schema.String,
    pid: Schema.Number,
  }),
  error: ProtocolMismatch,
});

export const ListAgents = Rpc.make('agents.list', {
  success: Schema.Array(AgentInfo),
});

/** The agent new threads and fast requests use when none is named. Persisted. */
export const SetDefaultAgent = Rpc.make('agents.setDefault', {
  payload: { agentId: Schema.String },
  error: AgentUnavailable,
});

// ─── Threads ────────────────────────────────────────────────────────────────

export const CreateThread = Rpc.make('thread.create', {
  payload: {
    /** Omit for the default agent. */
    agentId: Schema.optionalKey(Schema.String),
    location: ThreadLocation,
    /** For `folder`, the thread's root. For `home`, the shell's directory, which the agent is given access to. */
    cwd: Schema.String,
  },
  success: ThreadSummary,
  error: AgentUnavailable,
});

/** Most recently used first. */
export const ListThreads = Rpc.make('thread.list', {
  payload: { limit: Schema.optionalKey(Schema.Number) },
  success: Schema.Array(ThreadSummary),
});

/**
 * Make `clientId` the thread's driver, and get its recent history so the
 * client can show where the conversation left off. `force` takes the thread
 * from another client that has it attached.
 */
export const AttachThread = Rpc.make('thread.attach', {
  payload: {
    threadId: Schema.String,
    clientId: Schema.String,
    force: Schema.Boolean,
    /** How many past turns of history to return. */
    historyTurns: Schema.Number,
  },
  success: Schema.Struct({ thread: ThreadSummary, history: Schema.Array(ThreadEvent) }),
  error: ThreadError,
});

export const DetachThread = Rpc.make('thread.detach', {
  payload: { threadId: Schema.String, clientId: Schema.String },
});

/**
 * Start a turn. Streams the turn's events, from `turn.started` to
 * `turn.ended`. The client must have the thread attached.
 */
export const Prompt = Rpc.make('thread.prompt', {
  payload: {
    threadId: Schema.String,
    clientId: Schema.String,
    text: Schema.String,
    context: PromptContext,
  },
  success: ThreadEvent,
  error: PromptError,
  stream: true,
});

/**
 * Follow a thread from just after `afterSeq`: replays stored events, then
 * streams live ones, and ends with the running turn's `turn.ended` (at once
 * when no turn is running).
 */
export const WatchThread = Rpc.make('thread.watch', {
  payload: { threadId: Schema.String, afterSeq: Schema.Number },
  success: ThreadEvent,
  error: ThreadNotFound,
  stream: true,
});

/** Stop the running turn. Pending permission requests are cancelled. */
export const CancelTurn = Rpc.make('thread.cancel', {
  payload: { threadId: Schema.String },
  error: ThreadNotFound,
});

/** Answer a permission request with one of its options, or null to refuse it outright. */
export const RespondToPermission = Rpc.make('thread.respond', {
  payload: { threadId: Schema.String, requestId: Schema.String, optionId: Schema.NullOr(Schema.String) },
  error: Schema.Union([ThreadNotFound, UnknownRequest]),
});

export const SetThreadMode = Rpc.make('thread.setMode', {
  payload: { threadId: Schema.String, modeId: Schema.String },
  error: Schema.Union([ThreadNotFound, AgentFailed]),
});

export const RenameThread = Rpc.make('thread.rename', {
  payload: { threadId: Schema.String, title: Schema.String },
  error: ThreadNotFound,
});

export const DeleteThread = Rpc.make('thread.delete', {
  payload: { threadId: Schema.String },
  error: ThreadNotFound,
});

/**
 * Get ready for a prompt the user is typing: start the agent and open or
 * resume the thread's session (or, with no thread, the agent alone).
 * Returns at once; the work happens in the background.
 */
export const PrewarmThread = Rpc.make('thread.prewarm', {
  payload: { threadId: Schema.optionalKey(Schema.String), agentId: Schema.optionalKey(Schema.String) },
});

// ─── Fast mode ──────────────────────────────────────────────────────────────

/** Have a warm fast-mode process ready for the agent (the default when omitted). Returns at once. */
export const PrewarmFast = Rpc.make('fast.prewarm', {
  payload: { agentId: Schema.optionalKey(Schema.String) },
});

/**
 * One fast request. Requests sharing a `sessionKey` continue one short
 * conversation ("now make it recursive"); `fast.end` lets it go.
 */
export const FastRequest = Rpc.make('fast.request', {
  payload: {
    agentId: Schema.optionalKey(Schema.String),
    sessionKey: Schema.String,
    input: FastInput,
  },
  success: FastEvent,
  error: FastError,
  stream: true,
});

export const EndFast = Rpc.make('fast.end', {
  payload: { sessionKey: Schema.String },
});

// ─── The daemon itself ──────────────────────────────────────────────────────

export const DaemonStatus = Rpc.make('daemon.status', {
  success: Schema.Struct({
    pid: Schema.Number,
    daemonVersion: Schema.String,
    startedAt: Schema.Number,
    clients: Schema.Number,
    runningTurns: Schema.Number,
    agentProcesses: Schema.Number,
    fastWorkers: Schema.Number,
  }),
});

/** Ask the daemon to exit. With `ifIdle`, only when no turn is running; the result says whether it will. */
export const Shutdown = Rpc.make('daemon.shutdown', {
  payload: { ifIdle: Schema.Boolean },
  success: Schema.Boolean,
});

export class DaemonRpcs extends RpcGroup.make(
  Hello,
  ListAgents,
  SetDefaultAgent,
  CreateThread,
  ListThreads,
  AttachThread,
  DetachThread,
  Prompt,
  WatchThread,
  CancelTurn,
  RespondToPermission,
  SetThreadMode,
  RenameThread,
  DeleteThread,
  PrewarmThread,
  PrewarmFast,
  FastRequest,
  EndFast,
  DaemonStatus,
  Shutdown,
) {}
