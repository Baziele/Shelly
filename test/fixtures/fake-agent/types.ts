import type {
  AgentCapabilities,
  ContentBlock,
  Implementation,
  PermissionOption,
  PlanEntry,
  SessionConfigOption,
  SessionModeState,
  SessionUpdate,
  StopReason,
  ToolCallContent,
  ToolCallLocation,
  ToolCallStatus,
  ToolKind,
} from '@agentclientprotocol/sdk';

/*
 * The shape of a fake agent scenario: what the agent says it can do, and what
 * it plays back for each prompt. A scenario file is JSON, or a TS module whose
 * default export has this shape. Field names inside steps follow the ACP v1
 * schema (@agentclientprotocol/sdk) wherever they map onto it.
 */

export interface FakeAgentScenario {
  readonly name?: string;
  readonly agentInfo?: Implementation;
  /** Shorthands for common capabilities; `agentCapabilities` is merged over them. */
  readonly capabilities?: {
    /** session/load. Default true. */
    readonly loadSession?: boolean;
    /** session/resume (sessionCapabilities.resume). Default true. */
    readonly resume?: boolean;
    readonly image?: boolean;
    readonly embeddedContext?: boolean;
  };
  readonly agentCapabilities?: AgentCapabilities;
  /** Modes returned by session/new, load and resume. */
  readonly modes?: SessionModeState;
  /**
   * Models. ACP v1 carries them as a config option with category "model";
   * this adds that option (and the older `models` field some clients read).
   */
  readonly models?: {
    readonly currentModelId: string;
    readonly availableModels: ReadonlyArray<{ readonly modelId: string; readonly name: string; readonly description?: string }>;
  };
  readonly configOptions?: SessionConfigOption[];
  /** Id for the first session/new; later ones get `-2`, `-3`… appended. Default `fake-session-1`. */
  readonly sessionId?: string;
  /** Histories replayed by session/load, by session id; `*` matches any id. */
  readonly history?: Readonly<Record<string, readonly Step[]>>;
  /** First matching rule picks the script for a prompt. */
  readonly rules?: readonly Rule[];
  /** Played when no rule matches. Default: echo. */
  readonly defaultScript?: Script;
  /** Named scripts that rules can refer to. */
  readonly scripts?: Readonly<Record<string, readonly Step[]>>;
}

/** Steps, or the name of an entry in `scripts`. */
export type Script = readonly Step[] | string;

export interface Rule {
  /** Substring of the prompt text (case-insensitive), or a regular expression. */
  readonly match: string | { readonly regex: string; readonly flags?: string };
  readonly script: Script;
}

interface Timed {
  /** Wait this long before the step. */
  readonly delayMs?: number;
}

interface Streamed {
  readonly text: string;
  /** Split the text into chunks of this many characters, one per tick. Default: all at once. */
  readonly charsPerTick?: number;
  /** Time between chunks. Default 50. */
  readonly tickMs?: number;
}

/** Shorthand content: `{ type: 'text', text }` for plain text (such as command output), or any ACP ToolCallContent. */
export type StepContent = { readonly type: 'text'; readonly text: string } | ToolCallContent;

export type Step = Timed & (
  /** agent_message_chunk. */
  | ({ readonly type: 'message' } & Streamed)
  /** agent_thought_chunk. */
  | ({ readonly type: 'thought' } & Streamed)
  /** user_message_chunk (useful in histories). */
  | { readonly type: 'user'; readonly text: string }
  /** Replies with the prompt it received: its text blocks verbatim, or the whole prompt as JSON. */
  | { readonly type: 'echo'; readonly format?: 'text' | 'json'; readonly prefix?: string }
  | {
    readonly type: 'tool_call';
    readonly id: string;
    readonly title: string;
    readonly kind?: ToolKind;
    /** Default pending. */
    readonly status?: ToolCallStatus;
    readonly locations?: ToolCallLocation[];
    readonly content?: StepContent[];
    readonly rawInput?: unknown;
  }
  | {
    readonly type: 'tool_update';
    readonly id: string;
    readonly status?: ToolCallStatus;
    readonly title?: string;
    readonly kind?: ToolKind;
    readonly locations?: ToolCallLocation[];
    readonly content?: StepContent[];
    readonly rawOutput?: unknown;
  }
  | { readonly type: 'plan'; readonly entries: PlanEntry[] }
  /** current_mode_update. */
  | { readonly type: 'mode'; readonly modeId: string }
  /** Any other session/update, sent as is. */
  | { readonly type: 'update'; readonly update: SessionUpdate }
  /**
   * session/request_permission. Then plays the branch for the chosen
   * option: looked up by optionId, then by option kind, then `cancelled`
   * (if the client cancelled), then `default`; then carries on.
   */
  | {
    readonly type: 'permission';
    readonly toolCall: { readonly id: string; readonly title?: string; readonly kind?: ToolKind; readonly content?: StepContent[]; readonly locations?: ToolCallLocation[] };
    /** Default: allow once, allow always, reject. */
    readonly options?: PermissionOption[];
    readonly branches?: Readonly<Record<string, Script>>;
  }
  /** Fails the session/prompt request with a JSON-RPC error. */
  | { readonly type: 'error'; readonly code?: number; readonly message: string; readonly data?: unknown }
  /** Ends the turn now. */
  | { readonly type: 'end'; readonly stopReason: StopReason }
  | { readonly type: 'wait'; readonly ms: number }
);

/** Lets a TS scenario file get type checking: `export default defineScenario({...})`. */
export const defineScenario = (scenario: FakeAgentScenario): FakeAgentScenario => scenario;

export type { ContentBlock };
