import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Queue from 'effect/Queue';
import * as Stream from 'effect/Stream';
import { AgentUnavailable, UnknownRequest } from '../../protocol/errors.js';
import type { AgentInfo, FastEvent } from '../../protocol/schema.js';
import { AgentRuntime, type AgentSessionRequest, type AgentUpdate, FastService } from '../services.js';

/*
 * Test doubles for the agent seams. A FakeAgents records what the thread
 * service asked for and lets a test drive each turn by pushing updates, or
 * answers turns on its own from a script.
 */

export interface FakeTurn {
  /** The full prompt text the agent received. */
  readonly text: string;
  readonly request: AgentSessionRequest;
  push(...updates: AgentUpdate[]): void;
}

export const FAKE_AGENTS: readonly AgentInfo[] = [
  { id: 'fake', name: 'Fake Agent', available: true, unavailableReason: null, supportsFast: true, isDefault: true },
  { id: 'broken', name: 'Broken Agent', available: false, unavailableReason: 'Broken is not installed.', supportsFast: false, isDefault: false },
];

export class FakeAgents {
  readonly sessionRequests: AgentSessionRequest[] = [];
  readonly turns: FakeTurn[] = [];
  readonly responses: { requestId: string; optionId: string | null }[] = [];
  readonly modes: string[] = [];
  readonly released: string[] = [];
  readonly prewarmed: { agentId: string; threadId: string | null }[] = [];
  /** The session requests prewarm was given, in the order they came. */
  readonly prewarmSessions: AgentSessionRequest[] = [];
  readonly fastRequests: string[] = [];
  cancels = 0;
  /** When set, every turn answers itself with these updates (then waits for more, unless one is `end`). */
  script: ((prompt: string) => readonly AgentUpdate[]) | undefined;
  /** When set, `session` fails with it. */
  sessionError: AgentUnavailable | undefined;
  /** When set, `session` and `prewarm` wait for it before answering (a cold agent starting). */
  sessionGate: Promise<void> | undefined;
  /** When it returns true for a turn's prompt, `cancel` never returns and the turn never ends (a stuck agent). */
  ignoresCancel: ((prompt: string) => boolean) | undefined;
  private nativeCounter = 0;
  private waiters: ((turn: FakeTurn) => void)[] = [];
  private current: Queue.Queue<AgentUpdate> | undefined;

  constructor(options: { script?: (prompt: string) => readonly AgentUpdate[]; ignoresCancel?: (prompt: string) => boolean } = {}) {
    this.script = options.script;
    this.ignoresCancel = options.ignoresCancel;
  }

  /** The next turn the agent receives (or the latest, if it already arrived and nobody took it). */
  nextTurn(): Promise<FakeTurn> {
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  get lastTurn(): FakeTurn | undefined {
    return this.turns.at(-1);
  }

  private startTurn(text: string, request: AgentSessionRequest, queue: Queue.Queue<AgentUpdate>): void {
    this.current = queue;
    const turn: FakeTurn = { text, request, push: (...updates) => updates.forEach((update) => Queue.offerUnsafe(queue, update)) };
    this.turns.push(turn);
    for (const update of this.script?.(text) ?? []) {
      Queue.offerUnsafe(queue, update);
    }
    this.waiters.splice(0).forEach((resolve) => resolve(turn));
  }

  readonly runtime: AgentRuntime['Service'] = AgentRuntime.of({
    agents: Effect.sync(() => FAKE_AGENTS),
    session: (request) =>
      Effect.suspend(() => {
        this.sessionRequests.push(request);
        const gate = this.sessionGate;
        return gate ? Effect.promise(() => gate) : Effect.void;
      }).pipe(Effect.andThen(() => {
        if (this.sessionError) {
          return Effect.fail(this.sessionError);
        }
        const nativeSessionId = request.nativeSessionId ?? `native-${++this.nativeCounter}`;
        let lastPrompt = '';
        return Effect.succeed({
          nativeSessionId,
          startedFresh: request.nativeSessionId === null,
          modes: { currentModeId: 'default', availableModes: [{ id: 'default', name: 'Default', description: null }, { id: 'plan', name: 'Plan', description: null }] },
          prompt: (text: string) =>
            Stream.unwrap(
              Queue.unbounded<AgentUpdate>().pipe(Effect.map((queue) => {
                lastPrompt = text;
                this.startTurn(text, request, queue);
                return Stream.fromQueue(queue).pipe(Stream.takeUntil((update) => update.type === 'end'));
              })),
            ),
          cancel: Effect.suspend(() => {
            this.cancels++;
            if (this.ignoresCancel?.(lastPrompt)) {
              return Effect.never;
            }
            if (this.current) {
              Queue.offerUnsafe(this.current, { type: 'end', stopReason: 'cancelled', error: null });
            }
            return Effect.void;
          }),
          respond: (requestId: string, optionId: string | null) =>
            requestId.startsWith('unknown')
              ? Effect.fail(new UnknownRequest({ requestId }))
              : Effect.sync(() => {
                this.responses.push({ requestId, optionId });
                // A scripted agent finishes its turn once it has its answer.
                if (this.script && this.current) {
                  Queue.offerUnsafe(this.current, { type: 'permission.resolved', requestId, optionId });
                  Queue.offerUnsafe(this.current, { type: 'chunk', kind: 'text', text: optionId === 'allow' ? 'Done.' : 'Stopped.' });
                  Queue.offerUnsafe(this.current, { type: 'end', stopReason: 'end_turn', error: null });
                }
              }),
          setMode: (modeId: string) => Effect.sync(() => {
            this.modes.push(modeId);
          }),
        });
      })),
    prewarm: ({ agentId, session }) =>
      Effect.suspend(() => {
        const gate = this.sessionGate;
        return gate ? Effect.promise(() => gate) : Effect.void;
      }).pipe(Effect.andThen(Effect.sync(() => {
        this.prewarmed.push({ agentId, threadId: session?.threadId ?? null });
        if (session) {
          this.prewarmSessions.push(session);
        }
      }))),
    release: (threadId) => Effect.sync(() => {
      this.released.push(threadId);
    }),
    processCount: Effect.sync(() => (this.sessionRequests.length > 0 ? 1 : 0)),
  });

  readonly fast: FastService['Service'] = FastService.of({
    request: ({ agentId, input }) =>
      Stream.suspend(() => {
        this.fastRequests.push(input.instruction);
        if (agentId !== 'fake') {
          return Stream.fail(new AgentUnavailable({ agentId, reason: 'No fast mode.' }));
        }
        const events: FastEvent[] = [
          { type: 'delta', text: 'ls ' },
          { type: 'delta', text: '-la' },
          { type: 'done', text: 'ls -la', kind: 'command', durationMs: 1 },
        ];
        // "slow": the first delta, then nothing until the caller lets go (a request in flight).
        return input.instruction.includes('slow')
          ? Stream.concat(Stream.fromIterable(events.slice(0, 1)), Stream.never)
          : Stream.fromIterable(events);
      }),
    prewarm: () => Effect.void,
    end: () => Effect.void,
    workerCount: Effect.succeed(0),
  });

  layer(): Layer.Layer<AgentRuntime | FastService> {
    return Layer.mergeAll(Layer.succeed(AgentRuntime, this.runtime), Layer.succeed(FastService, this.fast));
  }
}

/** Answers every prompt with a short echo; asks permission when the request mentions "permission". */
export const echoScript = (prompt: string): readonly AgentUpdate[] => {
  const request = prompt.slice(prompt.lastIndexOf('</shelly_context>') + '</shelly_context>'.length).trim();
  if (request.includes('permission')) {
    return [
      { type: 'chunk', kind: 'text', text: 'May I?' },
      {
        type: 'permission',
        requestId: 'perm-1',
        toolCallId: null,
        title: 'Run a command',
        options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }, { optionId: 'reject', name: 'Reject', kind: 'reject_once' }],
      },
    ];
  }
  if (request.includes('wait')) {
    return [{ type: 'chunk', kind: 'text', text: 'Working' }];
  }
  return [
    { type: 'chunk', kind: 'text', text: 'echo: ' },
    { type: 'chunk', kind: 'text', text: request },
    { type: 'end', stopReason: 'end_turn', error: null },
  ];
};
