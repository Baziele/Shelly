import { chmodSync, existsSync, unlinkSync } from 'node:fs';
import * as NodeSocketServer from '@effect/platform-node/NodeSocketServer';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as RpcSerialization from 'effect/rpc/RpcSerialization';
import * as RpcServer from 'effect/rpc/RpcServer';
import * as SocketServer from 'effect/socket/SocketServer';
import { probeSocket } from '../protocol/probe.js';
import { DaemonRpcs } from '../protocol/rpc.js';
import { DaemonPaths } from './DaemonPaths.js';
import { Lifecycle } from './Lifecycle.js';
import * as RpcHandlers from './RpcHandlers.js';
import { ThreadService } from './ThreadService.js';

/*
 * The daemon's socket: Effect RPC, NDJSON, on `run/daemon.sock` (mode 0600
 * inside a 0700 directory). Each connection is counted for the idle timer.
 */

export class SocketInUse extends Error {
  constructor(readonly path: string) {
    super('Another Shelly daemon answers on the socket.');
  }
}

/** A socket file nobody answers on is left over from a daemon that died; remove it. */
const clearStaleSocket = Effect.fn('DaemonServer.clearStaleSocket')(function* (path: string) {
  if (!existsSync(path)) {
    return;
  }
  if (yield* Effect.promise(() => probeSocket(path))) {
    return yield* Effect.die(new SocketInUse(path));
  }
  yield* Effect.logInfo('removed a stale socket');
  yield* Effect.sync(() => unlinkSync(path));
});

const socketServerLayer: Layer.Layer<SocketServer.SocketServer, SocketServer.SocketServerError, DaemonPaths | Lifecycle> =
  Layer.effect(
    SocketServer.SocketServer,
    Effect.gen(function* () {
      const paths = yield* DaemonPaths;
      const lifecycle = yield* Lifecycle;
      yield* clearStaleSocket(paths.socket);
      const server = yield* NodeSocketServer.make({ path: paths.socket });
      yield* Effect.sync(() => chmodSync(paths.socket, 0o600));
      return SocketServer.SocketServer.of({
        address: server.address,
        run: (handler) =>
          server.run((socket) =>
            lifecycle.connectionOpened.pipe(Effect.andThen(handler(socket)), Effect.ensuring(lifecycle.connectionClosed))
          ),
      });
    }),
  );

/** Serves DaemonRpcs until its scope closes, which stops accepting and closes every connection. */
export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const lifecycle = yield* Lifecycle;
    const threads = yield* ThreadService;
    const onDisconnect = (connectionId: number) =>
      lifecycle.unbindConnection(connectionId).pipe(Effect.flatMap(Effect.forEach((clientId) => threads.releaseClient(clientId))));
    return RpcServer.layer(DaemonRpcs, { onDisconnect, disableTracing: true }).pipe(
      Layer.provide(RpcHandlers.layer),
      Layer.provide(RpcServer.layerProtocolSocketServer),
      Layer.provide(RpcSerialization.layerNdjson),
      Layer.provide(socketServerLayer),
    );
  }),
);

/** Ask the daemon to stop after `idleMs` with no connection and no running turn. */
export const idleExitLayer = (idleMs: number) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const lifecycle = yield* Lifecycle;
      const threads = yield* ThreadService;
      const interval = Math.max(10, Math.min(5000, Math.floor(idleMs / 4)));
      let idleSince = Date.now();
      yield* Effect.gen(function* () {
        const busy = (yield* lifecycle.connections) > 0 || (yield* threads.runningTurns) > 0;
        const now = Date.now();
        if (busy) {
          idleSince = now;
        } else if (now - idleSince >= idleMs) {
          yield* lifecycle.requestShutdown(`idle for ${Math.round(idleMs / 1000)}s`);
        }
      }).pipe(Effect.delay(interval), Effect.forever, Effect.forkScoped);
    }),
  );
