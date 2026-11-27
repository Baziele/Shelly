import * as Context from 'effect/Context';
import * as Deferred from 'effect/Deferred';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';

/*
 * The daemon's own state: when it started, who is connected, and whether it
 * has been asked to stop (by a client, a signal, or the idle timer).
 *
 * Connections are counted at the socket. RPC connection ids are tied to the
 * clientIds that used them, so a terminal that goes away lets go of its
 * threads once its last connection closes.
 */

export class Lifecycle extends Context.Service<
  Lifecycle,
  {
    readonly startedAt: number;
    readonly connectionOpened: Effect.Effect<void>;
    readonly connectionClosed: Effect.Effect<void>;
    readonly connections: Effect.Effect<number>;
    /** Record that an RPC connection speaks for `clientId`. */
    readonly bindClient: (connectionId: number, clientId: string) => Effect.Effect<void>;
    /** Forget a closed RPC connection; returns the clientIds it was the last connection for. */
    readonly unbindConnection: (connectionId: number) => Effect.Effect<readonly string[]>;
    readonly requestShutdown: (reason: string) => Effect.Effect<void>;
    readonly awaitShutdown: Effect.Effect<string>;
  }
>()('shelly/daemon/Lifecycle') {}

/** `shutdown` lets the process (signal handlers) ask for a stop from outside Effect. */
export const layer = (shutdown: Deferred.Deferred<string>): Layer.Layer<Lifecycle> =>
  Layer.sync(Lifecycle, () => {
    let connections = 0;
    const clientsByConnection = new Map<number, Set<string>>();
    const connectionCounts = new Map<string, number>();

    return Lifecycle.of({
      startedAt: Date.now(),
      connectionOpened: Effect.sync(() => {
        connections++;
      }),
      connectionClosed: Effect.sync(() => {
        connections = Math.max(0, connections - 1);
      }),
      connections: Effect.sync(() => connections),
      bindClient: (connectionId, clientId) =>
        Effect.sync(() => {
          const clients = clientsByConnection.get(connectionId) ?? new Set();
          if (clients.has(clientId)) {
            return;
          }
          clients.add(clientId);
          clientsByConnection.set(connectionId, clients);
          connectionCounts.set(clientId, (connectionCounts.get(clientId) ?? 0) + 1);
        }),
      unbindConnection: (connectionId) =>
        Effect.sync(() => {
          const gone: string[] = [];
          for (const clientId of clientsByConnection.get(connectionId) ?? []) {
            const left = (connectionCounts.get(clientId) ?? 1) - 1;
            if (left <= 0) {
              connectionCounts.delete(clientId);
              gone.push(clientId);
            } else {
              connectionCounts.set(clientId, left);
            }
          }
          clientsByConnection.delete(connectionId);
          return gone;
        }),
      requestShutdown: (reason) => Deferred.succeed(shutdown, reason).pipe(Effect.asVoid),
      awaitShutdown: Deferred.await(shutdown),
    });
  });
