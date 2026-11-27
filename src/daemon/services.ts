import * as Context from 'effect/Context';
import type * as Effect from 'effect/Effect';
import * as Schema from 'effect/Schema';
import type * as Stream from 'effect/Stream';
import type { AgentFailed, AgentUnavailable, UnknownRequest } from '../protocol/errors.js';
import type {
  AgentInfo,
  AgentMode,
  FastEvent,
  FastInput,
  PermissionOption,
  PlanEntry,
  StopReason,
  ToolCall,
} from '../protocol/schema.js';

/*
 * The seams inside the daemon. The thread service (threads, history,
 * attachment, prompts) sits on top of two services that talk to agents:
 *
 * - AgentRuntime runs agent mode over ACP: agent processes and sessions.
 * - FastService runs fast mode: warm, stripped-down model processes.
 *
 * Both read their per-agent settings from ShellyConfig.
 */

// ─── Configuration ($SHELLY_HOME/config.json) ───────────────────────────────

/**
 * Settings for one agent. The built-in agents (`claude`, `opencode`) need no
 * entry; one only overrides their defaults. Any other id defines a custom
 * ACP agent and must give `command`.
 */
export const AgentSettings = Schema.Struct({
  name: Schema.optionalKey(Schema.String),
  /** The ACP server to start, and its arguments. */
  command: Schema.optionalKey(Schema.String),
  args: Schema.optionalKey(Schema.Array(Schema.String)),
  env: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  /**
   * The model agent mode uses, as the agent names it (`haiku`, `opencode-go/hy4-flash-free`).
   * Omitted: the agent's own default.
   */
  model: Schema.optionalKey(Schema.String),
  /** The model fast mode uses; agents without one have no fast mode. */
  fastModel: Schema.optionalKey(Schema.String),
  /** false hides the agent. */
  enabled: Schema.optionalKey(Schema.Boolean),
});
export type AgentSettings = typeof AgentSettings.Type;

export const ConfigFile = Schema.Struct({
  defaultAgent: Schema.optionalKey(Schema.String),
  agents: Schema.optionalKey(Schema.Record(Schema.String, AgentSettings)),
});
export type ConfigFile = typeof ConfigFile.Type;

export class ShellyConfig extends Context.Service<
  ShellyConfig,
  {
    /** The current config; a missing or unreadable file reads as `{}` (the daemon logs why). */
    readonly get: Effect.Effect<ConfigFile>;
    /** Rewrites the file, keeping everything else in it. */
    readonly setDefaultAgent: (agentId: string) => Effect.Effect<void>;
  }
>()('shelly/daemon/ShellyConfig') {}

// ─── Agent mode ─────────────────────────────────────────────────────────────

export interface AgentSessionRequest {
  readonly agentId: string;
  /** Shelly's thread, for logs and for routing. */
  readonly threadId: string;
  /** The session's working directory. */
  readonly cwd: string;
  /** More directories the agent may work in: the user's shell directory, for a thread in Shelly's home. */
  readonly additionalDirectories: readonly string[];
  /** The agent's own session id from an earlier session, to resume; null for a new session. */
  readonly nativeSessionId: string | null;
}

/**
 * What an agent reports during a turn, already normalised from ACP. The
 * thread service numbers these, groups text into messages and stores them.
 */
export type AgentUpdate =
  | { readonly type: 'chunk'; readonly kind: 'text' | 'thought'; readonly text: string }
  | { readonly type: 'tool'; readonly tool: ToolCall }
  | { readonly type: 'plan'; readonly entries: readonly PlanEntry[] }
  | {
    readonly type: 'permission';
    readonly requestId: string;
    readonly toolCallId: string | null;
    readonly title: string;
    readonly options: readonly PermissionOption[];
  }
  | { readonly type: 'permission.resolved'; readonly requestId: string; readonly optionId: string | null }
  | { readonly type: 'mode'; readonly currentModeId: string; readonly availableModes: readonly AgentMode[] }
  /** The agent named the conversation (Claude Code does, early in the first turn). */
  | { readonly type: 'title'; readonly title: string }
  | { readonly type: 'notice'; readonly level: 'info' | 'warning' | 'error'; readonly text: string }
  | { readonly type: 'end'; readonly stopReason: StopReason; readonly error: string | null };

export interface AgentSession {
  /** Persist this to resume the session later. It can differ from the one requested (a resume that fell back to a new session). */
  readonly nativeSessionId: string;
  /** True when the requested session could not be resumed and this one starts fresh. */
  readonly startedFresh: boolean;
  readonly modes: { readonly currentModeId: string; readonly availableModes: readonly AgentMode[] } | null;
  /**
   * Run one turn with the full prompt text. The stream always ends with
   * exactly one `end` update; agent failures during the turn arrive as an
   * `end` with stopReason `error`, not as a stream failure.
   */
  readonly prompt: (text: string) => Stream.Stream<AgentUpdate>;
  /** Stop the running turn, if any; its stream then ends with stopReason `cancelled`. */
  readonly cancel: Effect.Effect<void>;
  readonly respond: (requestId: string, optionId: string | null) => Effect.Effect<void, UnknownRequest>;
  readonly setMode: (modeId: string) => Effect.Effect<void, AgentFailed>;
}

export class AgentRuntime extends Context.Service<
  AgentRuntime,
  {
    /** Every known agent and whether it can be used. Passive: never starts a session or a login. */
    readonly agents: Effect.Effect<readonly AgentInfo[]>;
    /**
     * A ready session for the thread: the live one if it is still open,
     * otherwise the agent's session resumed (or loaded), otherwise a new one.
     * Idle sessions are released by the runtime on its own.
     */
    readonly session: (request: AgentSessionRequest) => Effect.Effect<AgentSession, AgentUnavailable | AgentFailed>;
    /** Start the agent's process (and, when given, resume the session) so a prompt soon after is fast. */
    readonly prewarm: (request: { readonly agentId: string; readonly session: AgentSessionRequest | null }) => Effect.Effect<void>;
    /** Release a thread's live session now (the thread was deleted, say). */
    readonly release: (threadId: string) => Effect.Effect<void>;
    readonly processCount: Effect.Effect<number>;
  }
>()('shelly/daemon/AgentRuntime') {}

// ─── Fast mode ──────────────────────────────────────────────────────────────

export class FastService extends Context.Service<
  FastService,
  {
    /** Streams `delta`s, then exactly one `done`. */
    readonly request: (request: {
      readonly agentId: string;
      readonly sessionKey: string;
      readonly input: FastInput;
    }) => Stream.Stream<FastEvent, AgentUnavailable | AgentFailed>;
    /** Have a warm worker ready for the agent. Returns at once. */
    readonly prewarm: (agentId: string) => Effect.Effect<void>;
    /** Let go of the conversation behind `sessionKey`. */
    readonly end: (sessionKey: string) => Effect.Effect<void>;
    readonly workerCount: Effect.Effect<number>;
  }
>()('shelly/daemon/FastService') {}
