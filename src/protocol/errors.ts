import * as Schema from 'effect/Schema';
import { ERROR_MESSAGES } from './error-messages.js';

/** Errors the daemon returns to clients. Messages are shown to the user as they are. */

export class ProtocolMismatch extends Schema.TaggedError<ProtocolMismatch>()('ProtocolMismatch', {
  daemonProtocol: Schema.Number,
  clientProtocol: Schema.Number,
}) {
  override get message(): string {
    return ERROR_MESSAGES.ProtocolMismatch(this);
  }
}

export class ThreadNotFound extends Schema.TaggedError<ThreadNotFound>()('ThreadNotFound', {
  threadId: Schema.String,
}) {
  override get message(): string {
    return ERROR_MESSAGES.ThreadNotFound();
  }
}

export class ThreadBusy extends Schema.TaggedError<ThreadBusy>()('ThreadBusy', {
  threadId: Schema.String,
  /** The client that has it attached. */
  attachedBy: Schema.String,
}) {
  override get message(): string {
    return ERROR_MESSAGES.ThreadBusy();
  }
}

export class TurnInProgress extends Schema.TaggedError<TurnInProgress>()('TurnInProgress', {
  threadId: Schema.String,
}) {
  override get message(): string {
    return ERROR_MESSAGES.TurnInProgress();
  }
}

export class AgentUnavailable extends Schema.TaggedError<AgentUnavailable>()('AgentUnavailable', {
  agentId: Schema.String,
  reason: Schema.String,
}) {
  override get message(): string {
    return ERROR_MESSAGES.AgentUnavailable(this);
  }
}

/** The agent refused or failed a request outside a turn (starting or resuming a session, say). */
export class AgentFailed extends Schema.TaggedError<AgentFailed>()('AgentFailed', {
  agentId: Schema.String,
  reason: Schema.String,
}) {
  override get message(): string {
    return ERROR_MESSAGES.AgentFailed(this);
  }
}

export class UnknownRequest extends Schema.TaggedError<UnknownRequest>()('UnknownRequest', {
  requestId: Schema.String,
}) {
  override get message(): string {
    return ERROR_MESSAGES.UnknownRequest();
  }
}

export const ThreadError = Schema.Union([ThreadNotFound, ThreadBusy]);
export const PromptError = Schema.Union([ThreadNotFound, ThreadBusy, TurnInProgress, AgentUnavailable, AgentFailed]);
export const FastError = Schema.Union([AgentUnavailable, AgentFailed]);
