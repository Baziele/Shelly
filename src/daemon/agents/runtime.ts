import type * as Cause from 'effect/Cause';
import * as Deferred from 'effect/Deferred';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as Fiber from 'effect/Fiber';
import * as Layer from 'effect/Layer';
import * as Option from 'effect/Option';
import * as Queue from 'effect/Queue';
import * as Scope from 'effect/Scope';
import * as Semaphore from 'effect/Semaphore';
import * as Stream from 'effect/Stream';
import { ChildProcessSpawner } from 'effect/process';
import type * as Acp from '../../acp/compat.js';
import type * as AcpError from '../../acp/errors.js';
import { AgentFailed, AgentUnavailable, UnknownRequest } from '../../protocol/errors.js';
import type { PermissionOption, StopReason } from '../../protocol/schema.js';
import {
  AgentRuntime,
  type AgentSession,
  type AgentSessionRequest,
  type AgentUpdate,
  ShellyConfig,
} from '../services.js';
import { type AgentDefinition, agentDefinitions, agentInfos, type SessionSetup } from './definitions.js';
import {
  mapPermissionOptions,
  mapSessionUpdate,
  mapStopReason,
  type ModeSource,
  type ModeState,
  modeConfigOption,
  modesFromConfigOption,
  modesFromSession,
  sameModes,
  ToolTracker,
} from './mapping.js';
import { cancelIdle, type IdleTimer, idleTimer, startIdle, stopFiber } from './idle.js';
import { type AgentProcess, type ProtocolTap, type SessionSink, shutdownAgentProcess, spawnAgentProcess } from './process.js';

/*
 * AgentRuntime over ACP. One process per agent, shared by its sessions; one
 * live session per thread. Sessions close after a few idle minutes and
 * processes exit a little after their last session; both come back on the
 * next `session()` (resumed, so the agent keeps the conversation).
 *
 * State is plain mutable objects owned by this closure. Each thread's
 * session changes run under that thread's lock, and each agent's process
 * changes under that agent's lock; what runs on the ACP reader fiber
 * (updates, permission requests, process exit) only does synchronous work.
 */

export interface AgentRuntimeOptions {
  /**
   * Extra per-agent session setup, by agent id: ACP `_meta` sent on
   * session/new and resume (for Claude Code, `{ claudeCode: { options } }`
   * reaches the Agent SDK), and config options set after the session opens.
   * Shelly itself passes none, so the user's own agent settings apply.
   */
  readonly sessionDefaults?: Readonly<Record<string, {
    readonly meta?: Readonly<Record<string, unknown>>;
    readonly configOptions?: Readonly<Record<string, string>>;
  }>>;
  /** The env agent definitions are resolved against. Default `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
  /** Test hook: called with each agent process's pid. */
  readonly onSpawn?: (info: { readonly agentId: string; readonly pid: number }) => void;
  /** How idle timers wait. Default `Effect.sleep`; tests fire them by hand. */
  readonly sleep?: (ms: number) => Effect.Effect<void>;
  /** Recording hook for fixtures: every JSON-RPC line with each agent. Never set in the daemon. */
  readonly onProtocolMessage?: ProtocolTap;
}

const AVAILABILITY_TTL_MS = 10_000;
const CLOSE_TIMEOUT = '5 seconds';
const SHORT_ERROR_CHARS = 200;

// ─── State ──────────────────────────────────────────────────────────────────

interface PendingPermission {
  readonly deferred: Deferred.Deferred<string | null>;
  readonly options: readonly PermissionOption[];
  readonly title: string;
}

interface Turn {
  readonly queue: Queue.Queue<AgentUpdate, Cause.Done>;
  readonly tools: ToolTracker;
  readonly permissions: Map<string, PendingPermission>;
  readonly done: Deferred.Deferred<void>;
  cancelRequested: boolean;
  /** The title of the last permission the user rejected in this turn. */
  rejected: string | null;
  ended: boolean;
}

interface LiveSession {
  readonly slot: ThreadSlot;
  readonly definition: AgentDefinition;
  readonly process: AgentProcess;
  readonly nativeSessionId: string;
  readonly cwd: string;
  additionalDirectories: readonly string[];
  modeSource: ModeSource;
  modes: ModeState | null;
  turn: Turn | null;
  /** Updates that arrived between turns, shown at the start of the next. */
  held: { title: string | null; mode: boolean };
  readonly idle: IdleTimer;
  closed: boolean;
}

interface ThreadSlot {
  readonly threadId: string;
  readonly lock: Semaphore.Semaphore;
  live: LiveSession | null;
  /** The last request, to reopen a released session when the thread is used again. */
  request: AgentSessionRequest | null;
  nativeSessionId: string | null;
  modes: ModeState | null;
  warming: boolean;
}

interface AgentSlot {
  readonly lock: Semaphore.Semaphore;
  process: AgentProcess | null;
  readonly idle: IdleTimer;
  /** Sessions being opened on the process; it must not idle out under them. */
  opening: number;
  warming: boolean;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

const sameDirectories = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && [...a].sort().every((dir, i) => dir === [...b].sort()[i]);

const short = (text: string): string => {
  const line = text.trim().split('\n')[0] ?? '';
  return line.length <= SHORT_ERROR_CHARS ? line : `${line.slice(0, SHORT_ERROR_CHARS - 1)}…`;
};

const isSessionNotFound = (error: AcpError.AcpRequestError): boolean =>
  error.code === -32002 || /not found|no conversation|unknown session|does not exist/i.test(error.errorMessage);

const isAuthRequired = (error: AcpError.AcpError): boolean =>
  error._tag === 'AcpRequestError' && error.code === -32000;

const processDied = (error: AcpError.AcpError, process: AgentProcess): boolean =>
  error._tag === 'AcpProcessExitedError' || error._tag === 'AcpInputStreamEndedError' || !process.isAlive();

const supported = (capability: unknown): boolean => capability !== undefined && capability !== null;

const CANCELLED: Acp.RequestPermissionResponse = { outcome: { outcome: 'cancelled' } };

// ─── The service ────────────────────────────────────────────────────────────

const make = (options: AgentRuntimeOptions) => Effect.gen(function* () {
  const config = yield* ShellyConfig;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const scope = yield* Scope.Scope;
  // Agent processes live in their own scope, closed first on shutdown, so their
  // exits then read as deliberate rather than as crashes.
  const processScope = yield* Scope.make('parallel');
  let shuttingDown = false;
  const env = options.env ?? process.env;
  const idleSleep = options.sleep ?? Effect.sleep;

  const agentSlots = new Map<string, AgentSlot>();
  const threadSlots = new Map<string, ThreadSlot>();
  /** Processes Shelly is stopping on purpose; their exit is not news. */
  const stopping = new WeakSet<AgentProcess>();
  let permissionCounter = 0;
  let definitionCache: { readonly key: string; readonly at: number; readonly definitions: readonly AgentDefinition[] } | null = null;

  // Untraced: called on every request; the operation that calls it carries the span.
  const definitions = Effect.fnUntraced(function* () {
    const file = yield* config.get;
    const key = JSON.stringify(file);
    const now = Date.now();
    if (definitionCache === null || definitionCache.key !== key || now - definitionCache.at > AVAILABILITY_TTL_MS) {
      definitionCache = { key, at: now, definitions: agentDefinitions(file, env) };
    }
    return { file, definitions: definitionCache.definitions };
  });

  const resolveAgent = Effect.fnUntraced(function* (agentId: string) {
    const { definitions: all } = yield* definitions();
    const definition = all.find((candidate) => candidate.id === agentId && candidate.enabled);
    if (!definition) {
      return yield* new AgentUnavailable({ agentId, reason: `Shelly doesn't know an agent called “${agentId}”.` });
    }
    if (!definition.launch.ok) {
      return yield* new AgentUnavailable({ agentId, reason: definition.launch.reason });
    }
    return definition;
  });

  const agentSlot = (agentId: string): AgentSlot => {
    let slot = agentSlots.get(agentId);
    if (!slot) {
      slot = { lock: Semaphore.makeUnsafe(1), process: null, idle: idleTimer(), opening: 0, warming: false };
      agentSlots.set(agentId, slot);
    }
    return slot;
  };

  const threadSlot = (threadId: string): ThreadSlot => {
    let slot = threadSlots.get(threadId);
    if (!slot) {
      slot = {
        threadId,
        lock: Semaphore.makeUnsafe(1),
        live: null,
        request: null,
        nativeSessionId: null,
        modes: null,
        warming: false,
      };
      threadSlots.set(threadId, slot);
    }
    return slot;
  };

  // ─── Processes ────────────────────────────────────────────────────────────

  const scheduleProcessIdle = (slot: AgentSlot, agentProcess: AgentProcess): Effect.Effect<void> =>
    startIdle(slot.idle, scope, agentProcess.definition.processIdleMs, (current, claim) =>
      slot.lock.withPermit(Effect.suspend(() => {
        if (!current() || slot.process !== agentProcess || agentProcess.sessions.size > 0 || slot.opening > 0) {
          return Effect.void;
        }
        claim();
        slot.process = null;
        stopping.add(agentProcess);
        // Outside the lock: a new process may start while this one takes its time to die.
        return Effect.logDebug('agent process idle, stopping').pipe(
          Effect.annotateLogs({ agentId: agentProcess.definition.id }),
          Effect.andThen(shutdownAgentProcess(agentProcess).pipe(Effect.forkIn(scope))),
          Effect.asVoid,
        );
      })), idleSleep);

  const onTerminated = (agentProcess: AgentProcess, error: AcpError.AcpError): Effect.Effect<void> =>
    Effect.suspend(() => {
      if (shuttingDown || stopping.has(agentProcess)) {
        return Effect.void;
      }
      const agentId = agentProcess.definition.id;
      const slot = agentSlots.get(agentId);
      // Clear its idle timer now: by the time the cleanup below runs, the slot may hold a new process.
      let idleFiber: Fiber.Fiber<void> | null = null;
      if (slot?.process === agentProcess) {
        idleFiber = slot.idle.fiber;
        slot.idle.fiber = null;
        slot.idle.token = null;
        slot.process = null;
      }
      // Its sessions are lost; the next session() for their threads respawns and resumes.
      const lost: LiveSession[] = [];
      for (const thread of threadSlots.values()) {
        const live = thread.live;
        if (live?.process === agentProcess) {
          live.closed = true;
          thread.live = null;
          lost.push(live);
        }
      }
      agentProcess.sessions.clear();
      return Effect.gen(function* () {
        yield* Effect.logWarning('agent process stopped unexpectedly').pipe(Effect.annotateLogs({
          agentId,
          pid: agentProcess.pid,
          ...(error._tag === 'AcpProcessExitedError'
            ? { exitCode: error.code ?? null, signal: error.signal ?? null }
            : { reason: error._tag }),
        }));
        yield* Effect.logDebug('agent stderr tail').pipe(
          Effect.annotateLogs({ agentId, stderrTail: agentProcess.stderrTail() }),
        );
        yield* stopFiber(idleFiber);
        yield* Effect.forEach(lost, (live) => cancelIdle(live.idle), { discard: true });
        // Let running turns see their prompt fail and end, then release what is left.
        yield* Effect.forEach(lost, (live) => live.turn ? Deferred.await(live.turn.done) : Effect.void, { discard: true })
          .pipe(Effect.timeoutOption('2 seconds'));
        stopping.add(agentProcess);
        yield* shutdownAgentProcess(agentProcess);
      }).pipe(Effect.forkIn(scope), Effect.asVoid);
    });

  /** The agent's running process, started if need be. */
  const ensureProcess = Effect.fn('AgentRuntime.ensureProcess')(function* (definition: AgentDefinition) {
    yield* Effect.annotateCurrentSpan({ agentId: definition.id });
    const slot = agentSlot(definition.id);
    return yield* slot.lock.withPermit(Effect.gen(function* () {
      if (slot.process?.isAlive()) {
        yield* cancelIdle(slot.idle);
        return slot.process;
      }
      const started = yield* spawnAgentProcess(definition, processScope, {
        onTerminated,
        onSpawn: options.onSpawn,
        onProtocolMessage: options.onProtocolMessage,
      }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );
      slot.process = started;
      return started;
    }));
  });

  // ─── Turns ────────────────────────────────────────────────────────────────

  const offer = (turn: Turn, update: AgentUpdate): void => {
    if (!turn.ended) {
      Queue.offerUnsafe(turn.queue, update);
    }
  };

  /** Answers one permission request; false if it was already answered. */
  const resolvePermission = (turn: Turn, requestId: string, optionId: string | null): boolean => {
    const pending = turn.permissions.get(requestId);
    if (!pending) {
      return false;
    }
    turn.permissions.delete(requestId);
    offer(turn, { type: 'permission.resolved', requestId, optionId });
    const kind = pending.options.find((option) => option.optionId === optionId)?.kind;
    if (kind === 'reject_once' || kind === 'reject_always') {
      turn.rejected = pending.title;
    }
    Deferred.doneUnsafe(pending.deferred, Exit.succeed(optionId));
    return true;
  };

  const applyModes = (live: LiveSession, next: ModeState | null): void => {
    if (next === null || sameModes(live.modes, next)) {
      return;
    }
    live.modes = next;
    live.slot.modes = next;
    if (live.turn && !live.turn.ended) {
      offer(live.turn, { type: 'mode', currentModeId: next.currentModeId, availableModes: next.availableModes });
    } else {
      live.held.mode = true;
    }
  };

  const applyConfigOptions = (live: LiveSession, configOptions: readonly Acp.SessionConfigOption[]): void => {
    const option = modeConfigOption(configOptions);
    if (!option) {
      return;
    }
    if (live.modeSource.kind === 'config') {
      applyModes(live, modesFromConfigOption(option));
    } else if (live.modeSource.kind === 'modes' && live.modes?.availableModes.some((mode) => mode.id === option.currentValue)) {
      applyModes(live, { ...live.modes, currentModeId: option.currentValue });
    }
  };

  const sinkFor = (live: LiveSession): SessionSink => ({
    onUpdate: (update) =>
      Effect.sync(() => {
        const turn = live.turn && !live.turn.ended ? live.turn : null;
        const mapped = mapSessionUpdate(update, turn?.tools ?? new ToolTracker());
        switch (mapped.kind) {
          case 'update':
            if (turn) {
              offer(turn, mapped.update);
            } else if (mapped.update.type === 'title') {
              live.held.title = mapped.update.title;
            }
            return;
          case 'mode':
            if (live.modes) {
              applyModes(live, { ...live.modes, currentModeId: mapped.currentModeId });
            }
            return;
          case 'config':
            applyConfigOptions(live, mapped.configOptions);
            return;
          case 'ignore':
            return;
        }
      }),
    onPermission: (request) =>
      Effect.suspend(() => {
        const turn = live.turn && !live.turn.ended ? live.turn : null;
        // No turn to ask in, or the user already stopped it.
        if (!turn || turn.cancelRequested) {
          return Effect.succeed(CANCELLED);
        }
        const requestId = `permission-${++permissionCounter}`;
        const tool = turn.tools.apply(request.toolCall);
        offer(turn, { type: 'tool', tool });
        const options = mapPermissionOptions(request.options);
        const title = request.title ?? request.toolCall.title ?? tool.title;
        const deferred = Deferred.makeUnsafe<string | null>();
        turn.permissions.set(requestId, { deferred, options, title });
        offer(turn, { type: 'permission', requestId, toolCallId: request.toolCall.toolCallId, title, options });
        return Deferred.await(deferred).pipe(
          Effect.map((optionId): Acp.RequestPermissionResponse =>
            optionId === null ? CANCELLED : { outcome: { outcome: 'selected', optionId } }),
          // The agent withdrew the request (or its connection went away).
          Effect.onInterrupt(() => Effect.sync(() => resolvePermission(turn, requestId, null))),
        );
      }),
  });

  const scheduleSessionIdle = (live: LiveSession): Effect.Effect<void> =>
    live.closed
      ? cancelIdle(live.idle)
      : startIdle(live.idle, scope, live.definition.sessionIdleMs, (current, claim) =>
        live.slot.lock.withPermit(Effect.suspend(() => {
          if (!current() || live.closed || live.turn) {
            return Effect.void;
          }
          claim();
          return Effect.logDebug('session idle, closing').pipe(
            Effect.annotateLogs({ agentId: live.definition.id, threadId: live.slot.threadId }),
            Effect.andThen(closeLive(live)),
          );
        })), idleSleep);

  const endFor = (live: LiveSession, turn: Turn, exit: Exit.Exit<Acp.PromptResponse, AcpError.AcpError>) => {
    const name = live.definition.name;
    const notices: AgentUpdate[] = [];
    let stopReason: StopReason;
    let error: string | null = null;
    if (Exit.isSuccess(exit) && (exit.value.error || (exit.value.stopReason as string) === 'error')) {
      // ACP v2 ends a failed turn with an idle state (stopReason `error`, and an
      // `error`) instead of failing the prompt request: Claude Code signed out ends so.
      const failure = exit.value.error;
      stopReason = 'error';
      error = failure?.code === -32000 || live.process.signedOut()
        ? live.definition.signInMessage
        : `${name} failed: ${short(failure?.message ?? '') || 'unknown error'}`;
    } else if (Exit.isSuccess(exit)) {
      stopReason = mapStopReason(exit.value.stopReason);
      if (
        stopReason === 'cancelled' && turn.rejected !== null && !turn.cancelRequested
        && live.definition.quirks.rejectEndsTurnCancelled
      ) {
        // OpenCode ends the turn as cancelled when the user rejects a tool: it was the
        // user's answer, not a stop.
        stopReason = 'end_turn';
        notices.push({ type: 'notice', level: 'info', text: `Rejected: ${turn.rejected}` });
      }
    } else {
      const failure = Option.getOrUndefined(Exit.findErrorOption(exit));
      if (failure === undefined) {
        stopReason = 'interrupted';
      } else if (isAuthRequired(failure)) {
        stopReason = 'error';
        error = live.definition.signInMessage;
      } else if (processDied(failure, live.process)) {
        stopReason = 'error';
        error = `${name} stopped unexpectedly.`;
      } else if (failure._tag === 'AcpRequestError') {
        stopReason = 'error';
        error = live.process.signedOut()
          ? live.definition.signInMessage
          : `${name} failed: ${short(failure.errorMessage) || 'unknown error'}`;
      } else {
        stopReason = 'error';
        error = `${name} failed.`;
      }
    }
    return { notices, end: { type: 'end', stopReason, error } as const };
  };

  const finishTurn = (live: LiveSession, turn: Turn, exit: Exit.Exit<Acp.PromptResponse, AcpError.AcpError>) =>
    Effect.suspend(() => {
      if (turn.ended) {
        return Effect.void;
      }
      for (const requestId of [...turn.permissions.keys()]) {
        resolvePermission(turn, requestId, null);
      }
      const { notices, end } = endFor(live, turn, exit);
      for (const notice of notices) {
        offer(turn, notice);
      }
      offer(turn, end);
      turn.ended = true;
      Queue.endUnsafe(turn.queue);
      Deferred.doneUnsafe(turn.done, Exit.void);
      if (live.turn === turn) {
        live.turn = null;
      }
      return Effect.logDebug('turn ended').pipe(
        Effect.annotateLogs({ agentId: live.definition.id, threadId: live.slot.threadId, stopReason: end.stopReason }),
        Effect.andThen(live.closed ? Effect.void : scheduleSessionIdle(live)),
      );
    });

  const cancelTurn = (live: LiveSession, turn: Turn): Effect.Effect<void> =>
    Effect.suspend(() => {
      if (turn.ended) {
        return Effect.void;
      }
      turn.cancelRequested = true;
      for (const requestId of [...turn.permissions.keys()]) {
        resolvePermission(turn, requestId, null);
      }
      return live.process.acp.agent.cancel({ sessionId: live.nativeSessionId }).pipe(Effect.ignore);
    });

  // ─── Sessions ─────────────────────────────────────────────────────────────

  const failed = (definition: AgentDefinition, agentProcess: AgentProcess, action: string) =>
    (error: AcpError.AcpError) =>
      new AgentFailed({
        agentId: definition.id,
        reason: isAuthRequired(error)
          ? definition.signInMessage
          : processDied(error, agentProcess)
            ? `${definition.name} stopped unexpectedly.`
            : error._tag === 'AcpRequestError'
              ? `${definition.name} couldn't ${action}: ${short(error.errorMessage)}`
              : `${definition.name} couldn't ${action}.`,
      });

  /** The agent's own setup (its configured model), with the runtime's options on top. */
  const sessionSetupFor = (definition: AgentDefinition): SessionSetup => {
    const extra = options.sessionDefaults?.[definition.id];
    const own = definition.sessionSetup;
    const meta = own.meta || extra?.meta ? { ...own.meta, ...extra?.meta } : undefined;
    const configOptions = own.configOptions || extra?.configOptions ? { ...own.configOptions, ...extra?.configOptions } : undefined;
    return { ...(meta ? { meta } : {}), ...(configOptions ? { configOptions } : {}) };
  };

  /** Resumes the requested session (or loads it), else starts a new one. */
  const openSession = Effect.fn('AgentRuntime.openSession')(function* (
    agentProcess: AgentProcess,
    definition: AgentDefinition,
    request: AgentSessionRequest,
  ) {
    yield* Effect.annotateCurrentSpan({ agentId: definition.id, threadId: request.threadId });
    const capabilities = agentProcess.initialize.agentCapabilities ?? {};
    const sessionCapabilities = capabilities.sessionCapabilities ?? {};
    const defaults = sessionSetupFor(definition);
    const base = {
      cwd: request.cwd,
      mcpServers: [],
      ...(supported(sessionCapabilities.additionalDirectories) && request.additionalDirectories.length > 0
        ? { additionalDirectories: [...request.additionalDirectories] }
        : {}),
      ...(defaults?.meta ? { _meta: defaults.meta as Record<string, never> } : {}),
    };
    const toFailure = failed(definition, agentProcess, 'open a session');

    let opened: { sessionId: string; response: Acp.LoadSessionResponse; startedFresh: boolean } | null = null;
    let startedFresh = false;
    if (request.nativeSessionId !== null) {
      const sessionId = request.nativeSessionId;
      const notFound = (error: AcpError.AcpRequestError) =>
        isSessionNotFound(error) ? Effect.succeed(null) : Effect.fail(error);
      // session/resume continues without replaying; session/load replays history we'd only discard.
      const response = supported(sessionCapabilities.resume)
        ? yield* agentProcess.acp.agent.resumeSession({ sessionId, ...base }).pipe(
          Effect.catchTags({ AcpRequestError: notFound }),
          Effect.mapError(toFailure),
        )
        : capabilities.loadSession
          ? yield* agentProcess.acp.agent.loadSession({ sessionId, ...base }).pipe(
            Effect.catchTags({ AcpRequestError: notFound }),
            Effect.mapError(toFailure),
          )
          : null;
      if (response !== null) {
        opened = { sessionId, response, startedFresh: false };
      } else {
        startedFresh = true;
        yield* Effect.logInfo('session could not be resumed, starting a new one').pipe(
          Effect.annotateLogs({ agentId: definition.id, threadId: request.threadId }),
        );
      }
    }
    if (opened === null) {
      const response = yield* agentProcess.acp.agent.createSession(base).pipe(Effect.mapError(toFailure));
      opened = { sessionId: response.sessionId, response, startedFresh };
    }

    let configOptions = opened.response.configOptions ?? null;
    for (const [configId, value] of Object.entries(defaults?.configOptions ?? {})) {
      const current = configOptions?.find((option) => option.id === configId);
      if (current?.currentValue === value) {
        continue;
      }
      const result = yield* agentProcess.acp.agent.setSessionConfigOption({ sessionId: opened.sessionId, configId, value }).pipe(
        Effect.option,
      );
      if (Option.isSome(result)) {
        configOptions = result.value.configOptions;
      } else {
        // A model the agent does not know (a typo in config.json): it carries on with its default.
        yield* Effect.logWarning(`the agent refused config option ${configId}=${value}; using its default`).pipe(
          Effect.annotateLogs({ agentId: definition.id }),
        );
      }
    }
    return { ...opened, response: { ...opened.response, configOptions } };
  });

  const closeLive = (live: LiveSession): Effect.Effect<void> =>
    Effect.gen(function* () {
      if (live.closed) {
        return;
      }
      live.closed = true;
      yield* cancelIdle(live.idle);
      if (live.slot.live === live) {
        live.slot.live = null;
      }
      live.process.sessions.delete(live.nativeSessionId);
      if (live.turn) {
        yield* cancelTurn(live, live.turn);
      }
      const sessionCapabilities = live.process.initialize.agentCapabilities?.sessionCapabilities ?? {};
      if (live.process.isAlive() && supported(sessionCapabilities.close)) {
        yield* live.process.acp.agent.closeSession({ sessionId: live.nativeSessionId }).pipe(
          Effect.timeoutOption(CLOSE_TIMEOUT),
          Effect.ignore,
        );
      }
      const slot = agentSlots.get(live.definition.id);
      if (slot?.process === live.process && live.process.sessions.size === 0 && slot.opening === 0) {
        yield* scheduleProcessIdle(slot, live.process);
      }
    });

  /** Moves a live session to new directories. Claude Code replaces it in place; others reopen it. */
  const redirect = Effect.fn('AgentRuntime.redirect')(function* (live: LiveSession, request: AgentSessionRequest) {
    const sessionCapabilities = live.process.initialize.agentCapabilities?.sessionCapabilities ?? {};
    if (!supported(sessionCapabilities.additionalDirectories)) {
      return true;
    }
    if (!live.definition.quirks.resumeReplacesLiveSession || !supported(sessionCapabilities.resume)) {
      return false;
    }
    const defaults = sessionSetupFor(live.definition);
    const response = yield* live.process.acp.agent.resumeSession({
      sessionId: live.nativeSessionId,
      cwd: live.cwd,
      mcpServers: [],
      additionalDirectories: [...request.additionalDirectories],
      ...(defaults?.meta ? { _meta: defaults.meta as Record<string, never> } : {}),
    }).pipe(Effect.option);
    if (Option.isNone(response)) {
      return false;
    }
    live.additionalDirectories = request.additionalDirectories;
    applyModes(live, modesFromSession(response.value).state);
    return true;
  });

  /** The thread's live session, reused or (re)opened. Runs under the thread's lock. */
  const acquireLocked = Effect.fn('AgentRuntime.acquire')(function* (slot: ThreadSlot, request: AgentSessionRequest) {
    yield* Effect.annotateCurrentSpan({ agentId: request.agentId, threadId: request.threadId });
    const previous = slot.request;
    slot.request = request;
    const definition = yield* resolveAgent(request.agentId);
    const current = slot.live;
    if (
      current && !current.closed && current.process.isAlive() && current.definition.id === request.agentId
      && current.cwd === request.cwd
      && (request.nativeSessionId === null || request.nativeSessionId === current.nativeSessionId)
    ) {
      yield* cancelIdle(current.idle);
      const moved = current.turn !== null || sameDirectories(current.additionalDirectories, request.additionalDirectories)
        || (yield* redirect(current, request));
      if (moved) {
        if (!current.turn) {
          yield* scheduleSessionIdle(current);
        }
        return { live: current, startedFresh: false };
      }
    }
    if (current && !current.closed) {
      yield* closeLive(current);
    }

    const processSlot = agentSlot(definition.id);
    processSlot.opening++;
    const { agentProcess, opened } = yield* Effect.gen(function* () {
      const agentProcess = yield* ensureProcess(definition);
      const opened = yield* openSession(agentProcess, definition, {
        ...request,
        // A thread whose session was lost or released keeps its conversation.
        nativeSessionId: request.nativeSessionId
          ?? (previous?.agentId === request.agentId && previous.cwd === request.cwd ? slot.nativeSessionId : null),
      });
      return { agentProcess, opened };
    }).pipe(Effect.ensuring(Effect.suspend(() => {
      processSlot.opening--;
      const idleProcess = processSlot.process;
      return idleProcess && idleProcess.sessions.size === 0 && processSlot.opening === 0 && processSlot.idle.token === null
        ? scheduleProcessIdle(processSlot, idleProcess)
        : Effect.void;
    })));

    const modes = modesFromSession(opened.response);
    const live: LiveSession = {
      slot,
      definition,
      process: agentProcess,
      nativeSessionId: opened.sessionId,
      cwd: request.cwd,
      additionalDirectories: request.additionalDirectories,
      modeSource: modes.source,
      modes: modes.state,
      turn: null,
      held: { title: null, mode: false },
      idle: idleTimer(),
      closed: false,
    };
    if (!agentProcess.isAlive()) {
      return yield* new AgentFailed({ agentId: definition.id, reason: `${definition.name} stopped unexpectedly.` });
    }
    agentProcess.sessions.set(live.nativeSessionId, sinkFor(live));
    yield* cancelIdle(processSlot.idle);
    slot.live = live;
    slot.nativeSessionId = live.nativeSessionId;
    slot.modes = live.modes;
    yield* scheduleSessionIdle(live);
    return { live, startedFresh: opened.startedFresh };
  });

  /** The live session, reopened (resumed) if it was released or its process died. */
  const liveFor = Effect.fnUntraced(function* (slot: ThreadSlot) {
    const current = slot.live;
    if (current && !current.closed && current.process.isAlive()) {
      return { live: current, startedFresh: false };
    }
    if (slot.request === null) {
      return yield* new AgentFailed({ agentId: 'unknown', reason: 'This session was released.' });
    }
    return yield* acquireLocked(slot, { ...slot.request, nativeSessionId: slot.nativeSessionId ?? slot.request.nativeSessionId });
  });

  const startTurn = (slot: ThreadSlot, text: string): Stream.Stream<AgentUpdate> =>
    Stream.unwrap(slot.lock.withPermit(Effect.gen(function* () {
      const endNow = (error: string) =>
        Stream.succeed<AgentUpdate>({ type: 'end', stopReason: 'error', error });
      const acquired = yield* liveFor(slot).pipe(Effect.result);
      if (acquired._tag === 'Failure') {
        return endNow(acquired.failure.reason);
      }
      const { live, startedFresh } = acquired.success;
      if (live.turn) {
        return endNow('The agent is still working on the last request.');
      }
      yield* cancelIdle(live.idle);

      const turn: Turn = {
        queue: yield* Queue.unbounded<AgentUpdate, Cause.Done>(),
        tools: new ToolTracker(),
        permissions: new Map(),
        done: yield* Deferred.make<void>(),
        cancelRequested: false,
        rejected: null,
        ended: false,
      };
      live.turn = turn;
      if (startedFresh) {
        offer(turn, {
          type: 'notice',
          level: 'warning',
          text: `${live.definition.name} couldn't resume the earlier conversation, so this starts a new one.`,
        });
      }
      if (live.held.title !== null) {
        offer(turn, { type: 'title', title: live.held.title });
      }
      if (live.held.mode && live.modes) {
        offer(turn, { type: 'mode', currentModeId: live.modes.currentModeId, availableModes: live.modes.availableModes });
      }
      live.held = { title: null, mode: false };

      yield* live.process.acp.agent.prompt({ sessionId: live.nativeSessionId, prompt: [{ type: 'text', text }] }).pipe(
        Effect.exit,
        Effect.flatMap((exit) => finishTurn(live, turn, exit)),
        Effect.onInterrupt(() => finishTurn(live, turn, Exit.interrupt())),
        Effect.forkIn(live.process.scope),
      );
      // A consumer that stops listening early stops the turn too.
      return Stream.fromQueue(turn.queue).pipe(Stream.ensuring(cancelTurn(live, turn)));
    })));

  const setMode = (slot: ThreadSlot, modeId: string): Effect.Effect<void, AgentFailed> =>
    slot.lock.withPermit(Effect.gen(function* () {
      const { live } = yield* liveFor(slot).pipe(
        Effect.catchTags({ AgentUnavailable: (error) => Effect.fail(new AgentFailed({ agentId: error.agentId, reason: error.reason })) }),
      );
      const definition = live.definition;
      const modes = live.modes;
      if (modes === null || live.modeSource.kind === 'none') {
        return yield* new AgentFailed({ agentId: definition.id, reason: `${definition.name} has no modes to switch.` });
      }
      if (!modes.availableModes.some((mode) => mode.id === modeId)) {
        return yield* new AgentFailed({ agentId: definition.id, reason: `${definition.name} has no mode “${modeId}”.` });
      }
      const toFailure = failed(definition, live.process, 'switch modes');
      const sessionId = live.nativeSessionId;
      if (live.modeSource.kind === 'modes') {
        yield* live.process.acp.agent.setSessionMode({ sessionId, modeId }).pipe(Effect.mapError(toFailure));
        applyModes(live, { ...modes, currentModeId: modeId });
      } else {
        const response = yield* live.process.acp.agent.setSessionConfigOption({
          sessionId,
          configId: live.modeSource.configId,
          value: modeId,
        }).pipe(Effect.mapError(toFailure));
        const option = modeConfigOption(response.configOptions);
        applyModes(live, option ? modesFromConfigOption(option) : { ...modes, currentModeId: modeId });
      }
    }));

  const sessionFacade = (slot: ThreadSlot, startedFresh: boolean): AgentSession => ({
    get nativeSessionId() {
      return slot.live?.nativeSessionId ?? slot.nativeSessionId ?? '';
    },
    startedFresh,
    get modes() {
      return slot.live?.modes ?? slot.modes;
    },
    prompt: (text) => startTurn(slot, text),
    cancel: Effect.suspend(() => {
      const live = slot.live;
      return live?.turn ? cancelTurn(live, live.turn) : Effect.void;
    }),
    respond: (requestId, optionId) =>
      Effect.suspend(() => {
        const turn = slot.live?.turn;
        const pending = turn?.permissions.get(requestId);
        if (!turn || !pending || (optionId !== null && !pending.options.some((option) => option.optionId === optionId))) {
          return Effect.fail(new UnknownRequest({ requestId }));
        }
        resolvePermission(turn, requestId, optionId);
        return Effect.void;
      }),
    setMode: (modeId) => setMode(slot, modeId),
  });

  const session = Effect.fn('AgentRuntime.session')(function* (request: AgentSessionRequest) {
    const slot = threadSlot(request.threadId);
    const { startedFresh } = yield* slot.lock.withPermit(acquireLocked(slot, request));
    return sessionFacade(slot, startedFresh);
  });

  const prewarm = Effect.fn('AgentRuntime.prewarm')(function* (request: {
    readonly agentId: string;
    readonly session: AgentSessionRequest | null;
  }) {
    if (request.session !== null) {
      const slot = threadSlot(request.session.threadId);
      if (slot.warming) {
        return;
      }
      // Also for a live session: reusing it restarts its idle timer, so a prewarm just
      // before it would have closed keeps it open for the prompt that follows.
      slot.warming = true;
      yield* slot.lock.withPermit(acquireLocked(slot, request.session)).pipe(
        Effect.tapError((error) => Effect.logDebug('prewarm failed').pipe(Effect.annotateLogs({ reason: error.reason }))),
        Effect.ignore,
        Effect.ensuring(Effect.sync(() => {
          slot.warming = false;
        })),
        Effect.forkIn(scope),
      );
      return;
    }
    const slot = agentSlot(request.agentId);
    if (slot.warming) {
      return;
    }
    const running = slot.process;
    if (running?.isAlive()) {
      // Restart the idle countdown of a process with no sessions, so it doesn't exit under the user.
      yield* slot.lock.withPermit(Effect.suspend(() =>
        slot.process === running && running.sessions.size === 0 && slot.opening === 0
          ? scheduleProcessIdle(slot, running)
          : Effect.void)).pipe(Effect.forkIn(scope));
      return;
    }
    slot.warming = true;
    yield* resolveAgent(request.agentId).pipe(
      Effect.flatMap((definition) => {
        slot.opening++;
        return ensureProcess(definition).pipe(Effect.ensuring(Effect.sync(() => {
          slot.opening--;
        })));
      }),
      Effect.flatMap((agentProcess) =>
        agentProcess.sessions.size === 0 && slot.opening === 0 ? scheduleProcessIdle(slot, agentProcess) : Effect.void),
      Effect.tapError((error) => Effect.logDebug('prewarm failed').pipe(Effect.annotateLogs({ reason: error.reason }))),
      Effect.ignore,
      Effect.ensuring(Effect.sync(() => {
        slot.warming = false;
      })),
      Effect.forkIn(scope),
    );
  });

  const release = Effect.fn('AgentRuntime.release')(function* (threadId: string) {
    const slot = threadSlots.get(threadId);
    if (!slot) {
      return;
    }
    yield* slot.lock.withPermit(Effect.suspend(() => slot.live ? closeLive(slot.live) : Effect.void));
    threadSlots.delete(threadId);
  });

  const agents = Effect.gen(function* () {
    const { file, definitions: all } = yield* definitions();
    return agentInfos(file, all);
  }).pipe(Effect.withSpan('AgentRuntime.agents'));

  const processCount = Effect.sync(() =>
    [...agentSlots.values()].filter((slot) => slot.process?.isAlive()).length);

  yield* Scope.addFinalizer(scope, Effect.suspend(() => {
    shuttingDown = true;
    return Scope.close(processScope, Exit.void);
  }));

  return AgentRuntime.of({ agents, session, prewarm, release, processCount });
});

/** AgentRuntime over ACP. Needs ShellyConfig and a ChildProcessSpawner (NodeServices.layer). */
export const layer: Layer.Layer<AgentRuntime, never, ShellyConfig | ChildProcessSpawner.ChildProcessSpawner> =
  Layer.effect(AgentRuntime, make({}));

/** The same with options, for tests and for runs with fixed models. */
export const layerWith = (
  options: AgentRuntimeOptions,
): Layer.Layer<AgentRuntime, never, ShellyConfig | ChildProcessSpawner.ChildProcessSpawner> =>
  Layer.effect(AgentRuntime, make(options));
