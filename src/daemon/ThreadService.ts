import { randomUUID } from 'node:crypto';
import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as Fiber from 'effect/Fiber';
import * as Layer from 'effect/Layer';
import * as Semaphore from 'effect/Semaphore';
import * as PubSub from 'effect/PubSub';
import * as Scope from 'effect/Scope';
import * as Stream from 'effect/Stream';
import {
  AgentFailed,
  AgentUnavailable,
  ThreadBusy,
  ThreadNotFound,
  TurnInProgress,
  UnknownRequest,
} from '../protocol/errors.js';
import type { AgentMode, ModeState, PromptContext, StopReason, ThreadEvent, ThreadLocation, ThreadSummary } from '../protocol/schema.js';
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
 * then published to everyone following the thread (the prompt's stream and
 * any watchers), one event at a time per thread so they arrive in order.
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
  /** The user stopped it; if the agent has not been prompted yet, it never is. */
  cancelRequested: boolean;
  fiber: Fiber.Fiber<void> | null;
}

/** What the daemon holds in memory for a thread it has touched since it started. */
interface LiveThread {
  attachedBy: string | null;
  nextSeq: number;
  /** A prompt is getting its session ready; the turn has not started yet. */
  starting: boolean;
  /** Cancel arrived while `starting`: the turn ends as soon as it is set up. */
  cancelRequested: boolean;
  /** Set by delete; a prompt still starting must not touch the thread after it. */
  deleted: boolean;
  turn: Turn | null;
  currentModeId: string | null;
  readonly events: PubSub.PubSub<ThreadEvent>;
  /**
   * Held while a turn is set up (once its session is ready), and by delete,
   * rename and cancel, so none of them lands in the middle of the setup.
   */
  readonly lock: Semaphore.Semaphore;
  /** Held from numbering an event until it is published, so followers get events in seq order. */
  readonly emitting: Semaphore.Semaphore;
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
  readonly clientRequestId?: string;
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
    /** The agent's modes for the thread, opening its session if need be; null when it has none. */
    readonly modes: (threadId: string, clientId: string) => Effect.Effect<ModeState | null, ThreadNotFound | ThreadBusy | AgentFailed>;
    readonly rename: (threadId: string, clientId: string, title: string) => Effect.Effect<void, ThreadNotFound | ThreadBusy>;
    readonly remove: (threadId: string, clientId: string) => Effect.Effect<void, ThreadNotFound | ThreadBusy>;
    /** Start the agent (and the thread's session) in the background. Returns at once. */
    readonly prewarm: (input: {
      readonly threadId?: string | undefined;
      readonly agentId?: string | undefined;
      /** The shell's directory, as the coming prompt's context will give it. */
      readonly cwd?: string | undefined;
    }) => Effect.Effect<void>;
    readonly runningTurns: Effect.Effect<number>;
  }
>()('shelly/daemon/ThreadService') {}

const DEFAULT_LIST_LIMIT = 50;
/** How long an agent gets to acknowledge a cancel. */
const CANCEL_TIMEOUT = '2 seconds';
const CANCEL_ON_SHUTDOWN_TIMEOUT = CANCEL_TIMEOUT;

const make = Effect.gen(function* () {
  const store = yield* ThreadStore;
  const runtime = yield* AgentRuntime;
  const agents = yield* AgentDirectory;
  const paths = yield* DaemonPaths;
  // Turns and background work live as long as the service; closing it
  // interrupts them, which ends running turns as `interrupted`.
  const scope = yield* Effect.scope;
  // Turns get a child scope that ends them all at once: each may wait up to
  // CANCEL_ON_SHUTDOWN_TIMEOUT for its agent, and the daemon holds its lock
  // until they are done.
  const turnScope = yield* Scope.fork(scope, 'parallel');

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
    const created: LiveThread = {
      attachedBy: null,
      nextSeq,
      starting: false,
      cancelRequested: false,
      deleted: false,
      turn: null,
      currentModeId: null,
      events,
      lock: Semaphore.makeUnsafe(1),
      emitting: Semaphore.makeUnsafe(1),
    };
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

  // Per event, so untraced: number it and store it. Callers hold `thread.emitting`.
  const record = Effect.fnUntraced(function* (threadId: string, thread: LiveThread, input: EventInput) {
    const event = { ...input, seq: thread.nextSeq++ } as ThreadEvent;
    yield* store.appendEvents(threadId, [event]);
    return event;
  });

  /**
   * Store an event, then tell everyone following the thread. Turns, respond
   * and setMode emit from different fibers: numbering through publishing is
   * one step per thread, or a later event could be published first.
   */
  const emit = (threadId: string, thread: LiveThread, input: EventInput) =>
    Semaphore.withPermit(
      thread.emitting,
      Effect.gen(function* () {
        const event = yield* record(threadId, thread, input);
        yield* PubSub.publish(thread.events, event);
        return event;
      }),
    );

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
    yield* Semaphore.withPermit(
      thread.emitting,
      Effect.gen(function* () {
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
      }),
    );
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
    // Like any other event, a mode change ends the current message (setMode
    // arrives here outside handleUpdate), so compaction keeps the two apart.
    if (thread.turn) {
      thread.turn.message = null;
    }
    yield* emit(threadId, thread, { type: 'mode.changed', currentModeId: mode.currentModeId, availableModes: mode.availableModes });
  });

  /** The agent named the conversation: that becomes the title, unless the user chose one. */
  const adoptAgentTitle = Effect.fnUntraced(function* (threadId: string, thread: LiveThread, title: string) {
    const clean = initialTitle(title);
    if (clean === '') {
      return;
    }
    // Under the thread's lock, as rename is, so a rename at the same moment always wins.
    yield* Semaphore.withPermit(
      thread.lock,
      Effect.gen(function* () {
        const row = yield* store.getThread(threadId);
        if (!row || row.titleSource === 'user' || clean === row.title) {
          return;
        }
        yield* store.updateThread(threadId, { title: clean, titleSource: 'agent' });
      }),
    );
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
      case 'title':
        yield* adoptAgentTitle(threadId, thread, update.title);
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
    Effect.suspend(() =>
      turn.cancelRequested
        ? Effect.void
        : turn.session.prompt(text).pipe(Stream.runForEach((update) => handleUpdate(threadId, thread, turn, update)))
    ).pipe(
      Effect.andThen(
        Effect.suspend(() =>
          turn.cancelRequested
            ? finishTurn(threadId, thread, turn, 'cancelled', null)
            // The runtime promises an `end`; if it never came, say so rather than hang.
            : finishTurn(threadId, thread, turn, 'error', 'The agent stopped without finishing its turn.')
        ),
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

  /**
   * After setup failed part-way: end the turn if clients heard it start,
   * set the thread idle, and let go of the session. Best effort: the setup's
   * own failure is what the prompt reports.
   */
  const abandonTurn = Effect.fnUntraced(function* (threadId: string, thread: LiveThread, turn: Turn, announced: boolean) {
    yield* Effect.logWarning(`turn setup failed thread=${threadId} turn=${turn.turnId}`);
    const settle = announced
      ? finishTurn(threadId, thread, turn, 'error', 'Shelly could not start this turn.')
      : store.updateThread(threadId, { status: 'idle' });
    yield* settle.pipe(Effect.catchCause(() => store.updateThread(threadId, { status: 'idle' })), Effect.ignoreCause);
    turn.ended = true;
    if (thread.turn === turn) {
      thread.turn = null;
    }
    yield* turn.session.cancel.pipe(Effect.timeout(CANCEL_ON_SHUTDOWN_TIMEOUT), Effect.ignoreCause);
    yield* runtime.release(threadId).pipe(Effect.ignoreCause);
  });

  /** Set up and fork a turn on a ready session. Runs holding the thread's lock. */
  const setUpTurn = Effect.fnUntraced(function* (input: PromptInput, thread: LiveThread, session: AgentSession) {
    const { threadId, text, context, clientRequestId } = input;
    // Read the thread again: it may have been deleted or renamed while the agent started.
    const row = thread.deleted ? undefined : yield* store.getThread(threadId);
    if (!row) {
      yield* runtime.release(threadId);
      return yield* new ThreadNotFound({ threadId });
    }
    const now = Date.now();
    const turn: Turn = {
      turnId: randomUUID(),
      startedAt: now,
      session,
      pending: new Set(),
      message: null,
      ended: false,
      cancelRequested: thread.cancelRequested,
      fiber: null,
    };
    thread.turn = turn;
    thread.starting = false;
    let announced = false;

    return yield* Effect.gen(function* () {
      yield* store.updateThread(threadId, {
        status: 'running',
        nativeSessionId: session.nativeSessionId,
        lastShellCwd: context.cwd,
        turnCount: row.turnCount + 1,
        updatedAt: now,
        // A generated title can replace this one later (see titles.ts).
        ...(row.title === '' ? { title: initialTitle(text) } : {}),
      });
      yield* emit(threadId, thread, { type: 'turn.started', turnId: turn.turnId, text, at: now, ...(clientRequestId === undefined ? {} : { clientRequestId }) });
      announced = true;
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
      turn.fiber = yield* runTurn(threadId, thread, turn, formatPromptForAgent(context, text)).pipe(Effect.forkIn(turnScope));
      return turn.turnId;
    }).pipe(Effect.onError(() => abandonTurn(threadId, thread, turn, announced)));
  });

  /** Starts a turn and returns the turn's id; the turn itself runs in the daemon's scope. */
  const startTurn = Effect.fn('ThreadService.startTurn')(function* (input: PromptInput, thread: LiveThread) {
    const { threadId, clientId, context } = input;
    const row = yield* requireThread(threadId);
    yield* requireDriver(threadId, thread, clientId);
    if (thread.turn || thread.starting) {
      return yield* new TurnInProgress({ threadId });
    }
    thread.starting = true;
    thread.cancelRequested = false;
    // Only waiting for the session may be interrupted (the client went away):
    // once it is ready, the turn is set up and forked as one step, so a
    // thread is never left marked busy with no turn running.
    return yield* Effect.uninterruptibleMask((restore) =>
      restore(runtime.session(sessionRequest(row, context.cwd))).pipe(
        Effect.flatMap((session) => Semaphore.withPermit(thread.lock, setUpTurn(input, thread, session))),
        Effect.ensuring(Effect.sync(() => {
          thread.starting = false;
          thread.cancelRequested = false;
        })),
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
        // Before liveThread, which would keep state for a thread that does not exist.
        yield* requireThread(input.threadId);
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
    yield* Semaphore.withPermit(
      thread.lock,
      Effect.gen(function* () {
        const turn = thread.turn;
        if (turn && !turn.ended) {
          turn.cancelRequested = true;
          // An agent that never answers must not hold the thread's lock.
          yield* turn.session.cancel.pipe(Effect.timeout(CANCEL_TIMEOUT), Effect.ignore);
        } else if (thread.starting) {
          // The agent is still starting: the turn ends as soon as it is set up.
          thread.cancelRequested = true;
        }
      }),
    );
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

  /**
   * The running turn's session, or the thread's session opened (or resumed)
   * for a call outside a turn. The caller records a changed session id, under
   * the thread's lock.
   */
  const sessionFor = (row: ThreadRow, thread: LiveThread) =>
    thread.turn?.session
      ? Effect.succeed(thread.turn.session)
      : runtime.session(sessionRequest(row, row.lastShellCwd)).pipe(
        Effect.catchTags({ AgentUnavailable: (error) => Effect.fail(new AgentFailed({ agentId: error.agentId, reason: error.reason })) }),
      );

  const setMode = Effect.fn('ThreadService.setMode')(function* (threadId: string, clientId: string, modeId: string) {
    const row = yield* requireThread(threadId);
    const thread = yield* liveThread(threadId);
    yield* requireDriver(threadId, thread, clientId);
    const session = yield* sessionFor(row, thread);
    // The thread may have been deleted while the agent started: write nothing, and let go of the session.
    const gone = Effect.gen(function* () {
      yield* runtime.release(threadId);
      return yield* new ThreadNotFound({ threadId });
    });
    if (thread.deleted) {
      return yield* gone;
    }
    yield* session.setMode(modeId);
    yield* Semaphore.withPermit(
      thread.lock,
      Effect.gen(function* () {
        if (thread.deleted || !(yield* store.getThread(threadId))) {
          return yield* gone;
        }
        if (session.nativeSessionId !== row.nativeSessionId) {
          yield* store.updateThread(threadId, { nativeSessionId: session.nativeSessionId });
        }
        yield* emitMode(threadId, thread, { currentModeId: modeId, availableModes: session.modes?.availableModes ?? [] });
      }),
    );
  });

  const modes = Effect.fn('ThreadService.modes')(function* (threadId: string, clientId: string) {
    const row = yield* requireThread(threadId);
    const thread = yield* liveThread(threadId);
    yield* requireDriver(threadId, thread, clientId);
    const session = yield* sessionFor(row, thread);
    if (thread.deleted) {
      yield* runtime.release(threadId);
      return yield* new ThreadNotFound({ threadId });
    }
    if (session.nativeSessionId !== row.nativeSessionId) {
      yield* Semaphore.withPermit(thread.lock, store.updateThread(threadId, { nativeSessionId: session.nativeSessionId }));
    }
    return session.modes;
  });

  const rename = Effect.fn('ThreadService.rename')(function* (threadId: string, clientId: string, title: string) {
    yield* requireThread(threadId);
    const thread = yield* liveThread(threadId);
    yield* requireDriverOrNobody(threadId, thread, clientId);
    const clean = title.replace(/\s+/g, ' ').trim();
    // An empty title keeps the one shown and hands naming back to the agent.
    yield* Semaphore.withPermit(
      thread.lock,
      store.updateThread(threadId, clean === '' ? { titleSource: 'prompt' } : { title: clean, titleSource: 'user' }),
    );
  });

  const remove = Effect.fn('ThreadService.remove')(function* (threadId: string, clientId: string) {
    yield* requireThread(threadId);
    // Always through the thread's lock, so work that started an agent session
    // for it meanwhile (a prompt, setMode, prewarm) sees the delete.
    const thread = yield* liveThread(threadId);
    yield* requireDriverOrNobody(threadId, thread, clientId);
    yield* Semaphore.withPermit(
      thread.lock,
      Effect.gen(function* () {
        // A prompt still waiting for its session sees this and stops without writing.
        thread.deleted = true;
        if (thread.turn?.fiber) {
          yield* Fiber.interrupt(thread.turn.fiber);
        }
        yield* runtime.release(threadId);
        yield* store.deleteThread(threadId);
        if (live.get(threadId) === thread) {
          live.delete(threadId);
        }
        yield* PubSub.shutdown(thread.events);
      }),
    );
  });

  const prewarm = Effect.fn('ThreadService.prewarm')(function* (input: {
    readonly threadId?: string | undefined;
    readonly agentId?: string | undefined;
    readonly cwd?: string | undefined;
  }) {
    const work = Effect.gen(function* () {
      const row = input.threadId ? yield* store.getThread(input.threadId) : undefined;
      if (row) {
        const thread = yield* liveThread(row.id);
        // The same request the prompt will make (startTurn uses its context's cwd), or the session is opened twice.
        yield* runtime.prewarm({ agentId: row.agentId, session: sessionRequest(row, input.cwd ?? row.lastShellCwd) });
        // Deleted while the agent started: let go of the session it opened.
        yield* Semaphore.withPermit(
          thread.lock,
          Effect.gen(function* () {
            if (thread.deleted || !(yield* store.getThread(row.id))) {
              yield* runtime.release(row.id);
              if (live.get(row.id) === thread) {
                live.delete(row.id);
              }
            }
          }),
        );
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
    modes,
    rename,
    remove,
    prewarm,
    runningTurns,
  });
});

export const layer: Layer.Layer<ThreadService, never, ThreadStore | AgentRuntime | AgentDirectory | DaemonPaths> =
  Layer.effect(ThreadService, make);
