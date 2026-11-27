import { randomUUID } from 'node:crypto';
import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as Fiber from 'effect/Fiber';
import * as Layer from 'effect/Layer';
import * as PubSub from 'effect/PubSub';
import * as Stream from 'effect/Stream';
import {
  AgentFailed,
  AgentUnavailable,
  ThreadBusy,
  ThreadNotFound,
  TurnInProgress,
  UnknownRequest,
} from '../protocol/errors.js';
import type { AgentMode, PromptContext, StopReason, ThreadEvent, ThreadLocation, ThreadSummary } from '../protocol/schema.js';
import { AgentDirectory } from './AgentDirectory.js';
import { DaemonPaths } from './DaemonPaths.js';
import { formatPromptForAgent } from './prompt.js';
import { AgentRuntime, type AgentSession, type AgentSessionRequest, type AgentUpdate } from './services.js';
import { ThreadStore, type ThreadRow } from './store/ThreadStore.js';
import { initialTitle } from './titles.js';

/*
 * Threads: their records, which client drives each one, and their turns.
 *
 * A turn runs in a fiber the daemon owns, not in the request that started
 * it, so it carries on when the prompt's stream goes away (the client broke
 * out of it, or disconnected). Each event is numbered per thread, stored,
 * then published to everyone following the thread: the prompt's stream and
 * any watchers.
 *
 * Privacy: never log prompt text, agent output or command output here.
 */

type EventInput = ThreadEvent extends infer E ? (E extends ThreadEvent ? Omit<E, 'seq'> : never) : never;

interface Turn {
  readonly turnId: string;
  readonly startedAt: number;
  readonly session: AgentSession;
  /** Open permission requests. */
  readonly pending: Set<string>;
  /** The message the next chunk of the same kind continues, if nothing else came in between. */
  message: { readonly id: string; readonly kind: 'text' | 'thought' } | null;
  ended: boolean;
  fiber: Fiber.Fiber<void> | null;
}

/** What the daemon holds in memory for a thread it has touched since it started. */
interface LiveThread {
  attachedBy: string | null;
  nextSeq: number;
  /** A prompt is getting its session ready; the turn has not started yet. */
  starting: boolean;
  turn: Turn | null;
  currentModeId: string | null;
  readonly events: PubSub.PubSub<ThreadEvent>;
}

export interface CreateThreadInput {
  readonly agentId?: string | undefined;
  readonly location: ThreadLocation;
  readonly cwd: string;
}

export interface PromptInput {
  readonly threadId: string;
  readonly clientId: string;
  readonly text: string;
  readonly context: PromptContext;
}

export class ThreadService extends Context.Service<
  ThreadService,
  {
    readonly create: (input: CreateThreadInput) => Effect.Effect<ThreadSummary, AgentUnavailable>;
    readonly list: (limit?: number) => Effect.Effect<readonly ThreadSummary[]>;
    readonly attach: (input: {
      readonly threadId: string;
      readonly clientId: string;
      readonly force: boolean;
      readonly historyTurns: number;
    }) => Effect.Effect<{ readonly thread: ThreadSummary; readonly history: readonly ThreadEvent[] }, ThreadNotFound | ThreadBusy>;
    readonly detach: (threadId: string, clientId: string) => Effect.Effect<void>;
    /** Let go of every thread the client has attached (its terminal went away). */
    readonly releaseClient: (clientId: string) => Effect.Effect<void>;
    readonly prompt: (
      input: PromptInput,
    ) => Stream.Stream<ThreadEvent, ThreadNotFound | ThreadBusy | TurnInProgress | AgentUnavailable | AgentFailed>;
    readonly watch: (threadId: string, afterSeq: number) => Stream.Stream<ThreadEvent, ThreadNotFound>;
    readonly cancel: (threadId: string, clientId: string) => Effect.Effect<void, ThreadNotFound | ThreadBusy>;
    readonly respond: (input: {
      readonly threadId: string;
      readonly clientId: string;
      readonly requestId: string;
      readonly optionId: string | null;
    }) => Effect.Effect<void, ThreadNotFound | ThreadBusy | UnknownRequest>;
    readonly setMode: (threadId: string, clientId: string, modeId: string) => Effect.Effect<void, ThreadNotFound | ThreadBusy | AgentFailed>;
    readonly rename: (threadId: string, clientId: string, title: string) => Effect.Effect<void, ThreadNotFound | ThreadBusy>;
    readonly remove: (threadId: string, clientId: string) => Effect.Effect<void, ThreadNotFound | ThreadBusy>;
    /** Start the agent (and the thread's session) in the background. Returns at once. */
    readonly prewarm: (input: { readonly threadId?: string | undefined; readonly agentId?: string | undefined }) => Effect.Effect<void>;
    readonly runningTurns: Effect.Effect<number>;
  }
>()('shelly/daemon/ThreadService') {}

const DEFAULT_LIST_LIMIT = 50;
const CANCEL_ON_SHUTDOWN_TIMEOUT = '2 seconds';

const make = Effect.gen(function* () {
  const store = yield* ThreadStore;
  const runtime = yield* AgentRuntime;
  const agents = yield* AgentDirectory;
  const paths = yield* DaemonPaths;
  // Turns and background work live as long as the service; closing it
  // interrupts them, which ends running turns as `interrupted`.
  const scope = yield* Effect.scope;

  const reconciled = yield* store.reconcile(Date.now());
  if (reconciled.length > 0) {
    yield* Effect.logInfo(`ended ${reconciled.length} turn(s) lost by the previous daemon`);
  }

  const live = new Map<string, LiveThread>();

  // ─── Helpers ──────────────────────────────────────────────────────────────

  const requireThread = Effect.fnUntraced(function* (threadId: string) {
    const row = yield* store.getThread(threadId);
    if (!row) {
      return yield* new ThreadNotFound({ threadId });
    }
    return row;
  });

  const liveThread = Effect.fnUntraced(function* (threadId: string) {
    const existing = live.get(threadId);
    if (existing) {
      return existing;
    }
    const nextSeq = (yield* store.lastSeq(threadId)) + 1;
    const events = yield* PubSub.unbounded<ThreadEvent>();
    // Another fiber may have created it while we read the store.
    const raced = live.get(threadId);
    if (raced) {
      return raced;
    }
    const created: LiveThread = { attachedBy: null, nextSeq, starting: false, turn: null, currentModeId: null, events };
    live.set(threadId, created);
    return created;
  });

  const summary = (row: ThreadRow): ThreadSummary => ({
    id: row.id,
    title: row.title,
    agentId: row.agentId,
    location: row.location,
    cwd: row.cwd,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    status: row.status,
    turnCount: row.turnCount,
    attachedBy: live.get(row.id)?.attachedBy ?? null,
  });

  /** Only the client driving the thread may act on it. */
  const requireDriver = (threadId: string, thread: LiveThread, clientId: string) =>
    thread.attachedBy === clientId
      ? Effect.void
      : Effect.fail(new ThreadBusy({ threadId, attachedBy: thread.attachedBy ?? '' }));

  /** Rename and delete also work when nobody has the thread attached. */
  const requireDriverOrNobody = (threadId: string, thread: LiveThread | undefined, clientId: string) =>
    !thread?.attachedBy || thread.attachedBy === clientId
      ? Effect.void
      : Effect.fail(new ThreadBusy({ threadId, attachedBy: thread.attachedBy }));

  const sessionRequest = (row: ThreadRow, shellCwd: string | null): AgentSessionRequest => ({
    agentId: row.agentId,
    threadId: row.id,
    cwd: row.cwd,
    additionalDirectories: row.location === 'home' && shellCwd ? [shellCwd] : [],
    nativeSessionId: row.nativeSessionId,
  });

  // Per event, so untraced: number it and store it.
  const record = Effect.fnUntraced(function* (threadId: string, thread: LiveThread, input: EventInput) {
    const event = { ...input, seq: thread.nextSeq++ } as ThreadEvent;
    yield* store.appendEvents(threadId, [event]);
    return event;
  });

  /** Store an event, then tell everyone following the thread. */
  const emit = Effect.fnUntraced(function* (threadId: string, thread: LiveThread, input: EventInput) {
    const event = yield* record(threadId, thread, input);
    yield* PubSub.publish(thread.events, event);
    return event;
  });

  const setStatus = (threadId: string, status: ThreadRow['status']) => store.updateThread(threadId, { status });

  // ─── Turns ────────────────────────────────────────────────────────────────

  const finishTurn = Effect.fnUntraced(function* (
    threadId: string,
    thread: LiveThread,
    turn: Turn,
    stopReason: StopReason,
    error: string | null,
  ) {
    if (turn.ended) {
      return;
    }
    turn.ended = true;
    for (const requestId of turn.pending) {
      yield* emit(threadId, thread, { type: 'permission.resolved', turnId: turn.turnId, requestId, optionId: null });
    }
    turn.pending.clear();
    const now = Date.now();
    const ended = yield* record(threadId, thread, {
      type: 'turn.ended',
      turnId: turn.turnId,
      stopReason,
      error,
      durationMs: Math.max(0, now - turn.startedAt),
    });
    // Settle the thread before anyone hears the turn ended, so a client
    // that prompts again straight away finds it idle.
    yield* store.compactTurn(threadId, turn.turnId);
    yield* store.updateThread(threadId, { status: 'idle', updatedAt: now });
    if (thread.turn === turn) {
      thread.turn = null;
    }
    yield* PubSub.publish(thread.events, ended);
    yield* Effect.logInfo(`turn ended thread=${threadId} turn=${turn.turnId} stopReason=${stopReason}`);
  });

  const resolvePermission = Effect.fnUntraced(function* (
    threadId: string,
    thread: LiveThread,
    turn: Turn,
    requestId: string,
    optionId: string | null,
  ) {
    if (!turn.pending.delete(requestId)) {
      return;
    }
    yield* emit(threadId, thread, { type: 'permission.resolved', turnId: turn.turnId, requestId, optionId });
    if (turn.pending.size === 0 && !turn.ended) {
      yield* setStatus(threadId, 'running');
    }
  });

  const emitMode = Effect.fnUntraced(function* (
    threadId: string,
    thread: LiveThread,
    mode: { readonly currentModeId: string; readonly availableModes: readonly AgentMode[] },
  ) {
    if (thread.currentModeId === mode.currentModeId) {
      return;
    }
    thread.currentModeId = mode.currentModeId;
    yield* emit(threadId, thread, { type: 'mode.changed', currentModeId: mode.currentModeId, availableModes: mode.availableModes });
  });

  // Per update, so untraced.
  const handleUpdate = Effect.fnUntraced(function* (threadId: string, thread: LiveThread, turn: Turn, update: AgentUpdate) {
    if (turn.ended) {
      return;
    }
    if (update.type === 'chunk') {
      const message = turn.message?.kind === update.kind ? turn.message : { id: randomUUID(), kind: update.kind };
      turn.message = message;
      yield* emit(threadId, thread, {
        type: 'message.chunk',
        turnId: turn.turnId,
        messageId: message.id,
        kind: update.kind,
        text: update.text,
      });
      return;
    }
    // Anything but text ends the current message: the next chunk starts a new one.
    turn.message = null;
    switch (update.type) {
      case 'tool':
        yield* emit(threadId, thread, { type: 'tool.updated', turnId: turn.turnId, tool: update.tool });
        return;
      case 'plan':
        yield* emit(threadId, thread, { type: 'plan.updated', turnId: turn.turnId, entries: update.entries });
        return;
      case 'permission':
        if (turn.pending.has(update.requestId)) {
          return;
        }
        turn.pending.add(update.requestId);
        yield* emit(threadId, thread, {
          type: 'permission.requested',
          turnId: turn.turnId,
          requestId: update.requestId,
          toolCallId: update.toolCallId,
          title: update.title,
          options: update.options,
        });
        yield* setStatus(threadId, 'waiting');
        return;
      case 'permission.resolved':
        yield* resolvePermission(threadId, thread, turn, update.requestId, update.optionId);
        return;
      case 'mode':
        yield* emitMode(threadId, thread, update);
        return;
      case 'notice':
        yield* emit(threadId, thread, { type: 'notice', turnId: turn.turnId, level: update.level, text: update.text });
        return;
      case 'end':
        yield* finishTurn(threadId, thread, turn, update.stopReason, update.error);
        return;
    }
  });

  const runTurn = (threadId: string, thread: LiveThread, turn: Turn, text: string): Effect.Effect<void> =>
    turn.session.prompt(text).pipe(
      Stream.runForEach((update) => handleUpdate(threadId, thread, turn, update)),
      Effect.andThen(
        // The runtime promises an `end`; if it never came, say so rather than hang.
        Effect.suspend(() => finishTurn(threadId, thread, turn, 'error', 'The agent stopped without finishing its turn.')),
      ),
      Effect.onExit((exit) => {
        if (Exit.isSuccess(exit) || turn.ended) {
          return Effect.void;
        }
        if (Exit.hasInterrupts(exit)) {
          // The daemon is shutting down or the thread was deleted.
          return turn.session.cancel.pipe(
            Effect.timeout(CANCEL_ON_SHUTDOWN_TIMEOUT),
            Effect.ignore,
            Effect.andThen(finishTurn(threadId, thread, turn, 'interrupted', null)),
          );
        }
        return Effect.logWarning(`turn failed thread=${threadId} turn=${turn.turnId}`).pipe(
          Effect.andThen(finishTurn(threadId, thread, turn, 'error', 'The agent failed unexpectedly.')),
        );
      }),
      Effect.withSpan('ThreadService.turn', { attributes: { threadId, turnId: turn.turnId } }),
    );

  /** Starts a turn and returns the turn's id; the turn itself runs in the daemon's scope. */
  const startTurn = Effect.fn('ThreadService.startTurn')(function* (input: PromptInput, thread: LiveThread) {
    const { threadId, clientId, text, context } = input;
    const row = yield* requireThread(threadId);
    yield* requireDriver(threadId, thread, clientId);
    if (thread.turn || thread.starting) {
      return yield* new TurnInProgress({ threadId });
    }
    thread.starting = true;
    // Only waiting for the session may be interrupted (the client went away):
    // once it is ready, the turn is set up and forked as one step, so a
    // thread is never left marked busy with no turn running.
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const session = yield* restore(runtime.session(sessionRequest(row, context.cwd)));
        const now = Date.now();
        const turn: Turn = {
          turnId: randomUUID(),
          startedAt: now,
          session,
          pending: new Set(),
          message: null,
          ended: false,
          fiber: null,
        };
        thread.turn = turn;
        thread.starting = false;

        yield* store.updateThread(threadId, {
          status: 'running',
          nativeSessionId: session.nativeSessionId,
          lastShellCwd: context.cwd,
          turnCount: row.turnCount + 1,
          updatedAt: now,
          // A generated title can replace this one later (see titles.ts).
          ...(row.title === '' ? { title: initialTitle(text) } : {}),
        });
        yield* emit(threadId, thread, { type: 'turn.started', turnId: turn.turnId, text, at: now });
        if (session.startedFresh && row.nativeSessionId !== null) {
          yield* emit(threadId, thread, {
            type: 'notice',
            turnId: turn.turnId,
            level: 'warning',
            text: 'The agent could not resume the earlier conversation, so this message starts a new one.',
          });
        }
        if (session.modes) {
          yield* emitMode(threadId, thread, session.modes);
        }
        yield* Effect.logInfo(`turn started thread=${threadId} turn=${turn.turnId}`);
        turn.fiber = yield* runTurn(threadId, thread, turn, formatPromptForAgent(context, text)).pipe(Effect.forkIn(scope));
        return turn.turnId;
      }).pipe(
        Effect.onExit((exit) =>
          Effect.sync(() => {
            thread.starting = false;
            if (!Exit.isSuccess(exit) && thread.turn && !thread.turn.fiber) {
              thread.turn = null;
            }
          })
        ),
      )
    );
  });

  // ─── Operations ───────────────────────────────────────────────────────────

  const create = Effect.fn('ThreadService.create')(function* (input: CreateThreadInput) {
    const agent = yield* agents.requireAvailable(input.agentId);
    const now = Date.now();
    const row: ThreadRow = {
      id: randomUUID(),
      title: '',
      agentId: agent.id,
      location: input.location,
      cwd: input.location === 'home' ? paths.threadHome : input.cwd,
      nativeSessionId: null,
      lastShellCwd: input.cwd,
      createdAt: now,
      updatedAt: now,
      status: 'idle',
      turnCount: 0,
    };
    yield* store.insertThread(row);
    return summary(row);
  });

  const list = Effect.fn('ThreadService.list')(function* (limit?: number) {
    return (yield* store.listThreads(limit ?? DEFAULT_LIST_LIMIT)).map(summary);
  });

  const attach = Effect.fn('ThreadService.attach')(function* (input: {
    readonly threadId: string;
    readonly clientId: string;
    readonly force: boolean;
    readonly historyTurns: number;
  }) {
    const row = yield* requireThread(input.threadId);
    const thread = yield* liveThread(input.threadId);
    if (thread.attachedBy && thread.attachedBy !== input.clientId && !input.force) {
      return yield* new ThreadBusy({ threadId: input.threadId, attachedBy: thread.attachedBy });
    }
    thread.attachedBy = input.clientId;
    const history = yield* store.history(input.threadId, input.historyTurns);
    return { thread: summary(row), history };
  });

  const detach = Effect.fn('ThreadService.detach')(function* (threadId: string, clientId: string) {
    const thread = live.get(threadId);
    if (thread?.attachedBy === clientId) {
      thread.attachedBy = null;
    }
  });

  const releaseClient = Effect.fn('ThreadService.releaseClient')(function* (clientId: string) {
    for (const thread of live.values()) {
      if (thread.attachedBy === clientId) {
        thread.attachedBy = null;
      }
    }
  });

  const prompt = (input: PromptInput) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const thread = yield* liveThread(input.threadId);
        // Subscribe before the turn starts so the stream sees all of it.
        const subscription = yield* PubSub.subscribe(thread.events);
        const turnId = yield* startTurn(input, thread);
        return Stream.fromSubscription(subscription).pipe(
          Stream.filter((event) => !('turnId' in event) || event.turnId === turnId),
          Stream.takeUntil((event) => event.type === 'turn.ended' && event.turnId === turnId),
        );
      }),
    );

  const watch = (threadId: string, afterSeq: number) =>
    Stream.unwrap(
      Effect.gen(function* () {
        yield* requireThread(threadId);
        const thread = yield* liveThread(threadId);
        // Subscribe first, then look: whatever is stored by now is replayed,
        // anything later arrives live, and the overlap is dropped by seq.
        const subscription = yield* PubSub.subscribe(thread.events);
        const runningTurnId = thread.turn?.turnId ?? null;
        const stored = yield* store.eventsAfter(threadId, afterSeq);
        const endIndex = stored.findIndex((event) => event.type === 'turn.ended' && event.turnId === runningTurnId);
        if (runningTurnId === null || endIndex >= 0) {
          return Stream.fromIterable(runningTurnId === null ? stored : stored.slice(0, endIndex + 1));
        }
        const lastSeq = stored.at(-1)?.seq ?? afterSeq;
        return Stream.concat(
          Stream.fromIterable(stored),
          Stream.fromSubscription(subscription).pipe(
            Stream.filter((event) => event.seq > lastSeq),
            Stream.takeUntil((event) => event.type === 'turn.ended' && event.turnId === runningTurnId),
          ),
        );
      }),
    );

  const cancel = Effect.fn('ThreadService.cancel')(function* (threadId: string, clientId: string) {
    yield* requireThread(threadId);
    const thread = yield* liveThread(threadId);
    yield* requireDriver(threadId, thread, clientId);
    if (thread.turn && !thread.turn.ended) {
      yield* thread.turn.session.cancel;
    }
  });

  const respond = Effect.fn('ThreadService.respond')(function* (input: {
    readonly threadId: string;
    readonly clientId: string;
    readonly requestId: string;
    readonly optionId: string | null;
  }) {
    yield* requireThread(input.threadId);
    const thread = yield* liveThread(input.threadId);
    yield* requireDriver(input.threadId, thread, input.clientId);
    const turn = thread.turn;
    if (!turn || !turn.pending.has(input.requestId)) {
      return yield* new UnknownRequest({ requestId: input.requestId });
    }
    yield* turn.session.respond(input.requestId, input.optionId);
    // The runtime may also report the resolution; whichever comes first wins.
    yield* resolvePermission(input.threadId, thread, turn, input.requestId, input.optionId);
  });

  const setMode = Effect.fn('ThreadService.setMode')(function* (threadId: string, clientId: string, modeId: string) {
    const row = yield* requireThread(threadId);
    const thread = yield* liveThread(threadId);
    yield* requireDriver(threadId, thread, clientId);
    const session = thread.turn?.session ?? (yield* runtime.session(sessionRequest(row, row.lastShellCwd)).pipe(
      Effect.catchTags({ AgentUnavailable: (error) => Effect.fail(new AgentFailed({ agentId: error.agentId, reason: error.reason })) }),
      Effect.tap((session) =>
        session.nativeSessionId === row.nativeSessionId
          ? Effect.void
          : store.updateThread(threadId, { nativeSessionId: session.nativeSessionId })
      ),
    ));
    yield* session.setMode(modeId);
    yield* emitMode(threadId, thread, { currentModeId: modeId, availableModes: session.modes?.availableModes ?? [] });
  });

  const rename = Effect.fn('ThreadService.rename')(function* (threadId: string, clientId: string, title: string) {
    yield* requireThread(threadId);
    yield* requireDriverOrNobody(threadId, live.get(threadId), clientId);
    yield* store.updateThread(threadId, { title: title.trim() });
  });

  const remove = Effect.fn('ThreadService.remove')(function* (threadId: string, clientId: string) {
    yield* requireThread(threadId);
    const thread = live.get(threadId);
    yield* requireDriverOrNobody(threadId, thread, clientId);
    if (thread?.turn?.fiber) {
      yield* Fiber.interrupt(thread.turn.fiber);
    }
    yield* runtime.release(threadId);
    yield* store.deleteThread(threadId);
    live.delete(threadId);
    if (thread) {
      yield* PubSub.shutdown(thread.events);
    }
  });

  const prewarm = Effect.fn('ThreadService.prewarm')(function* (input: {
    readonly threadId?: string | undefined;
    readonly agentId?: string | undefined;
  }) {
    const work = Effect.gen(function* () {
      const row = input.threadId ? yield* store.getThread(input.threadId) : undefined;
      if (row) {
        yield* runtime.prewarm({ agentId: row.agentId, session: sessionRequest(row, row.lastShellCwd) });
        return;
      }
      yield* runtime.prewarm({ agentId: yield* agents.resolve(input.agentId), session: null });
    });
    yield* work.pipe(Effect.ignoreCause({ log: 'Debug' }), Effect.forkIn(scope));
  });

  const runningTurns = Effect.sync(() => {
    let count = 0;
    for (const thread of live.values()) {
      if (thread.turn && !thread.turn.ended) {
        count++;
      }
    }
    return count;
  });

  return ThreadService.of({
    create,
    list,
    attach,
    detach,
    releaseClient,
    prompt,
    watch,
    cancel,
    respond,
    setMode,
    rename,
    remove,
    prewarm,
    runningTurns,
  });
});

export const layer: Layer.Layer<ThreadService, never, ThreadStore | AgentRuntime | AgentDirectory | DaemonPaths> =
  Layer.effect(ThreadService, make);
