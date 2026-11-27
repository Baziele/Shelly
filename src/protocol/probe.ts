import { connect } from 'node:net';

/*
 * Whether something accepts connections on the daemon's socket. Plain
 * node:net, so the client can call it without loading Effect.
 */

/**
 * `answers`: something accepted the connection. `refused`: nothing listens
 * (no socket file, or nobody bound to it). `silent`: no answer either way in
 * time, or another error; a daemon may be there but busy.
 */
export type SocketState = 'answers' | 'refused' | 'silent';

const REFUSED = new Set(['ENOENT', 'ECONNREFUSED']);

export const probeSocketState = (path: string, timeoutMs = 500): Promise<SocketState> =>
  new Promise((resolve) => {
    const socket = connect({ path });
    const done = (state: SocketState): void => {
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.on('error', () => {});
      socket.destroy();
      resolve(state);
    };
    const timer = setTimeout(() => done('silent'), timeoutMs);
    socket.once('connect', () => done('answers'));
    socket.once('error', (error: NodeJS.ErrnoException) => done(REFUSED.has(error.code ?? '') ? 'refused' : 'silent'));
  });

export const probeSocket = async (path: string, timeoutMs = 500): Promise<boolean> =>
  (await probeSocketState(path, timeoutMs)) === 'answers';
