import { connect } from 'node:net';

/*
 * Whether something accepts connections on the daemon's socket. Plain
 * node:net, so the client can call it without loading Effect.
 */
export const probeSocket = (path: string, timeoutMs = 500): Promise<boolean> =>
  new Promise((resolve) => {
    const socket = connect({ path });
    const done = (answered: boolean): void => {
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.on('error', () => {});
      socket.destroy();
      resolve(answered);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
