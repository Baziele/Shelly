import * as Schema from 'effect/Schema';

/** Errors the daemon returns to clients. Messages are shown to the user as they are. */

export class ProtocolMismatch extends Schema.TaggedError<ProtocolMismatch>()('ProtocolMismatch', {
  daemonProtocol: Schema.Number,
  clientProtocol: Schema.Number,
}) {
  override get message(): string {
    return `Shelly's background service speaks protocol ${this.daemonProtocol}, this terminal speaks ${this.clientProtocol}.`;
  }
}

export class ThreadNotFound extends Schema.TaggedError<ThreadNotFound>()('ThreadNotFound', {
  threadId: Schema.String,
}) {
  override get message(): string {
    return 'That thread no longer exists.';
  }
}

export class ThreadBusy extends Schema.TaggedError<ThreadBusy>()('ThreadBusy', {
  threadId: Schema.String,
  /** The client that has it attached. */
  attachedBy: Schema.String,
}) {
  override get message(): string {
    return 'That thread is open in another terminal.';
  }
}

export class TurnInProgress extends Schema.TaggedError<TurnInProgress>()('TurnInProgress', {
  threadId: Schema.String,
}) {
  override get message(): string {
    return 'The agent is still working on the last request.';
  }
}

export class AgentUnavailable extends Schema.TaggedError<AgentUnavailable>()('AgentUnavailable', {
  agentId: Schema.String,
  reason: Schema.String,
}) {
  override get message(): string {
    return this.reason;
  }
}

/** The agent refused or failed a request outside a turn (starting or resuming a session, say). */
export class AgentFailed extends Schema.TaggedError<AgentFailed>()('AgentFailed', {
  agentId: Schema.String,
  reason: Schema.String,
}) {
  override get message(): string {
    return this.reason;
  }
}

export class UnknownRequest extends Schema.TaggedError<UnknownRequest>()('UnknownRequest', {
  requestId: Schema.String,
}) {
  override get message(): string {
    return 'That request has already been answered or withdrawn.';
  }
}

export const ThreadError = Schema.Union([ThreadNotFound, ThreadBusy]);
export const PromptError = Schema.Union([ThreadNotFound, ThreadBusy, TurnInProgress, AgentUnavailable, AgentFailed]);
export const FastError = Schema.Union([AgentUnavailable, AgentFailed]);
