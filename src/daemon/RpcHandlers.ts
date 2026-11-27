import * as Effect from 'effect/Effect';
import * as Stream from 'effect/Stream';
import { ProtocolMismatch } from '../protocol/errors.js';
import { DaemonRpcs } from '../protocol/rpc.js';
import { PROTOCOL_VERSION } from '../protocol/schema.js';
import { SHELLY_VERSION } from '../version.js';
import { AgentDirectory } from './AgentDirectory.js';
import { Lifecycle } from './Lifecycle.js';
import { AgentRuntime, FastService } from './services.js';
import { ThreadService } from './ThreadService.js';

/*
 * The RPC handlers: decode (done by the RPC layer), call one service, map
 * errors. Calls that name a client also tie it to the connection, so its
 * attachments are released when the terminal goes away.
 */

/** Let the reply go out before the daemon starts closing connections. */
const SHUTDOWN_DELAY = '20 millis';

export const layer = DaemonRpcs.toLayer(
  Effect.gen(function* () {
    const threads = yield* ThreadService;
    const directory = yield* AgentDirectory;
    const runtime = yield* AgentRuntime;
    const fast = yield* FastService;
    const lifecycle = yield* Lifecycle;
    const scope = yield* Effect.scope;

    const bind = (options: { readonly client: { readonly id: number } }, clientId: string) =>
      lifecycle.bindClient(options.client.id, clientId);

    // Prompt, watch and fast streams open right now, from any client. A
    // daemon asked to stop only if idle stays up while any is open, or
    // replacing it would cut another terminal's stream.
    let openStreams = 0;
    const counted = <A, E, R>(stream: Stream.Stream<A, E, R>): Stream.Stream<A, E, R> =>
      Stream.unwrap(Effect.sync(() => {
        openStreams++;
        return stream.pipe(Stream.ensuring(Effect.sync(() => {
          openStreams--;
        })));
      }));

    return DaemonRpcs.of({
      hello: (payload, options) =>
        payload.protocolVersion === PROTOCOL_VERSION
          ? bind(options, payload.clientId).pipe(
            Effect.as({ protocolVersion: PROTOCOL_VERSION, daemonVersion: SHELLY_VERSION, pid: process.pid }),
          )
          : Effect.fail(new ProtocolMismatch({ daemonProtocol: PROTOCOL_VERSION, clientProtocol: payload.protocolVersion })),

      'agents.list': () => directory.list,
      'agents.setDefault': ({ agentId }) => directory.setDefault(agentId),

      'thread.create': ({ agentId, location, cwd }) => threads.create({ agentId, location, cwd }),
      'thread.list': ({ limit }) => threads.list(limit),
      'thread.attach': (payload, options) => bind(options, payload.clientId).pipe(Effect.andThen(threads.attach(payload))),
      'thread.detach': ({ threadId, clientId }, options) =>
        bind(options, clientId).pipe(Effect.andThen(threads.detach(threadId, clientId))),
      'thread.prompt': (payload, options) =>
        counted(Stream.unwrap(bind(options, payload.clientId).pipe(Effect.as(threads.prompt(payload))))),
      'thread.watch': ({ threadId, afterSeq }) => counted(threads.watch(threadId, afterSeq)),
      'thread.cancel': ({ threadId, clientId }, options) =>
        bind(options, clientId).pipe(Effect.andThen(threads.cancel(threadId, clientId))),
      'thread.respond': (payload, options) => bind(options, payload.clientId).pipe(Effect.andThen(threads.respond(payload))),
      'thread.setMode': ({ threadId, clientId, modeId }, options) =>
        bind(options, clientId).pipe(Effect.andThen(threads.setMode(threadId, clientId, modeId))),
      'thread.rename': ({ threadId, clientId, title }, options) =>
        bind(options, clientId).pipe(Effect.andThen(threads.rename(threadId, clientId, title))),
      'thread.delete': ({ threadId, clientId }, options) =>
        bind(options, clientId).pipe(Effect.andThen(threads.remove(threadId, clientId))),
      'thread.prewarm': ({ threadId, agentId, cwd }) => threads.prewarm({ threadId, agentId, cwd }),

      'fast.prewarm': ({ agentId }) =>
        directory.resolveFast(agentId).pipe(
          Effect.flatMap(fast.prewarm),
          Effect.ignoreCause({ log: 'Debug' }),
          Effect.forkIn(scope),
          Effect.asVoid,
        ),
      'fast.request': ({ agentId, sessionKey, input }) =>
        counted(Stream.unwrap(directory.resolveFast(agentId).pipe(Effect.map((agentId) => fast.request({ agentId, sessionKey, input }))))),
      'fast.end': ({ sessionKey }) => fast.end(sessionKey),

      'daemon.status': () =>
        Effect.all({
          clients: lifecycle.connections,
          runningTurns: threads.runningTurns,
          agentProcesses: runtime.processCount,
          fastWorkers: fast.workerCount,
        }).pipe(
          Effect.map((counts) => ({ pid: process.pid, daemonVersion: SHELLY_VERSION, startedAt: lifecycle.startedAt, ...counts })),
        ),
      'daemon.shutdown': ({ ifIdle }) =>
        Effect.gen(function* () {
          // Idle: no running turn, and no prompt, watch or fast request in flight from any client.
          if (ifIdle && ((yield* threads.runningTurns) > 0 || openStreams > 0)) {
            return false;
          }
          yield* lifecycle.requestShutdown('asked by a client').pipe(Effect.delay(SHUTDOWN_DELAY), Effect.forkIn(scope));
          return true;
        }),
    });
  }),
);
