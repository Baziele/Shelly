/*
 * What the daemon's errors say to the user, by `_tag`. Plain functions of
 * the error's fields, with no Effect import: the error classes in errors.ts
 * use them, and so does the client, which receives the errors as plain JSON.
 */

const text = (value: unknown, fallback: string): string => (typeof value === 'string' && value ? value : fallback);

export const ERROR_MESSAGES = {
  ProtocolMismatch: (error: { readonly daemonProtocol: unknown; readonly clientProtocol: unknown }) =>
    `Shelly's background service speaks protocol ${String(error.daemonProtocol)}, this terminal speaks ${String(error.clientProtocol)}.`,
  ThreadNotFound: () => 'That thread no longer exists.',
  ThreadBusy: () => 'That thread is open in another terminal.',
  TurnInProgress: () => 'The agent is still working on the last request.',
  AgentUnavailable: (error: { readonly reason: unknown }) => text(error.reason, 'That agent is not available.'),
  AgentFailed: (error: { readonly reason: unknown }) => text(error.reason, 'The agent failed.'),
  UnknownRequest: () => 'That request has already been answered or withdrawn.',
} as const;

export type DaemonErrorTag = keyof typeof ERROR_MESSAGES;

export const isDaemonErrorTag = (tag: unknown): tag is DaemonErrorTag =>
  typeof tag === 'string' && Object.hasOwn(ERROR_MESSAGES, tag);
