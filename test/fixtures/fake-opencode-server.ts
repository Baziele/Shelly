import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/*
 * A small fake of OpenCode 2.x's background service, enough for fast mode:
 * /api/info, the SSE event stream, sessions, prompts, interrupt, delete and
 * permission replies. Each prompt's <request> (or its whole text) picks
 * what the "model" does:
 *
 *   reply: <text>   streams <text> in a few deltas
 *   slow            streams forever until interrupted
 *   hang            never answers
 *   no-route | auth | error   fails the execution like OpenCode does
 *   permission      asks for a permission, then answers
 *   crash           drops every event stream and stops answering
 *   (anything else) answers `session=<id> turn=<n>`
 */

export interface FakeOpenCode {
  readonly url: string;
  readonly password: string;
  /** Every request, in order: `METHOD /path` plus the JSON body. */
  readonly requests: { readonly method: string; readonly path: string; readonly body: unknown }[];
  /** Live sessions by id. */
  readonly sessions: Map<string, { readonly body: unknown; readonly directory: string; readonly created: number; turns: number }>;
  /** Event streams currently open. */
  readonly streams: () => number;
  /** Add a session that no live client owns, as a crashed daemon would leave; made a minute ago unless `created` says. */
  readonly addLeftover: (directory: string, created?: number) => string;
  readonly close: () => Promise<void>;
}

const json = (response: ServerResponse, status: number, body: unknown) => {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(body === undefined ? '' : JSON.stringify(body));
};

const readBody = async (request: IncomingMessage): Promise<unknown> => {
  let text = '';
  for await (const chunk of request) text += chunk;
  return text === '' ? undefined : JSON.parse(text);
};

export const startFakeOpenCode = async (options: {
  readonly password?: string;
  readonly deltaMs?: number;
  /** Send a heartbeat comment on every stream this often, as the real service does every 15 s. */
  readonly heartbeatMs?: number;
} = {}): Promise<FakeOpenCode> => {
  const password = options.password ?? 'pässword';
  const deltaMs = options.deltaMs ?? 5;
  const expected = `Basic ${Buffer.from(`opencode:${password}`, 'utf8').toString('base64')}`;
  const streams = new Set<ServerResponse>();
  const requests: FakeOpenCode['requests'] = [];
  const sessions: FakeOpenCode['sessions'] = new Map();
  const running = new Map<string, () => void>();
  let nextId = 0;
  let crashed = false;

  const emit = (type: string, data: Record<string, unknown>) => {
    const frame = `id: evt_${++nextId}\nevent: message\ndata: ${JSON.stringify({ type, data })}\n\n`;
    for (const stream of streams) stream.write(frame);
  };
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  const execute = async (sessionID: string, text: string, turn: number) => {
    let stopped = false;
    running.set(sessionID, () => (stopped = true));
    const message = { sessionID, assistantMessageID: `msg_${turn}`, ordinal: 0 };
    emit('session.execution.started', { sessionID });
    const finish = (type: string, extra: Record<string, unknown> = {}) => {
      running.delete(sessionID);
      emit(type, { sessionID, ...extra });
    };
    const fail = (error: Record<string, unknown>) => finish('session.execution.failed', { error });
    if (text === 'hang') return;
    if (text === 'crash') {
      crashed = true;
      for (const stream of streams) stream.destroy();
      streams.clear();
      return;
    }
    if (text === 'no-route') return fail({ type: 'provider.no-route', message: 'Model unavailable: nosuch/model' });
    if (text === 'auth') return fail({ type: 'provider.auth', status: 401, message: 'Invalid API key' });
    if (text === 'error') return fail({ type: 'provider.error', message: 'Upstream exploded\nwith details' });
    if (text === 'permission') {
      emit('permission.asked', { sessionID, id: 'per_1', action: 'bash' });
      await wait(20);
    }
    // Reasoning is not part of the reply.
    emit('session.reasoning.delta', { ...message, delta: 'thinking…' });
    await wait(deltaMs);
    if (text === 'slow') {
      for (let n = 0; !stopped; n++) {
        emit('session.text.delta', { ...message, delta: `${n}\n` });
        await wait(50);
      }
      return finish('session.execution.interrupted');
    }
    const reply = text.startsWith('reply: ') ? text.slice('reply: '.length) : `session=${sessionID} turn=${turn}`;
    const size = Math.max(1, Math.ceil(reply.length / 3));
    for (let at = 0; at < reply.length; at += size) {
      if (stopped) return finish('session.execution.interrupted');
      emit('session.text.delta', { ...message, delta: reply.slice(at, at + size) });
      await wait(deltaMs);
    }
    emit('session.text.ended', { ...message, text: reply });
    finish('session.execution.succeeded');
  };

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://fake');
    const body = await readBody(request);
    requests.push({ method: request.method ?? 'GET', path: `${url.pathname}${url.search}`, body });
    if (crashed) {
      request.socket.destroy();
      return;
    }
    if (request.headers.authorization !== expected) return json(response, 401, { message: 'Unauthorized' });

    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    const [, resource, id, action, , subAction] = parts;
    if (url.pathname === '/api/info') return json(response, 200, { version: '2.4.1' });
    if (url.pathname === '/api/event') {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(`data: ${JSON.stringify({ type: 'server.connected', data: {} })}\n\n: heartbeat\n\n`);
      streams.add(response);
      response.on('close', () => streams.delete(response));
      return;
    }
    if (resource !== 'session') return json(response, 404, { message: 'Not found' });
    if (id === undefined && request.method === 'GET') {
      const directory = url.searchParams.get('directory');
      const data = [...sessions].filter(([, s]) => directory === null || s.directory === directory)
        .map(([sessionId, s]) => ({ id: sessionId, location: { directory: s.directory }, time: { created: s.created } }));
      return json(response, 200, { data, cursor: {} });
    }
    if (id === undefined && request.method === 'POST') {
      const sessionId = `ses_fake${++nextId}`;
      const directory = (body as { location?: { directory?: string } })?.location?.directory ?? '/';
      sessions.set(sessionId, { body, directory, created: Date.now(), turns: 0 });
      return json(response, 200, { data: { id: sessionId } });
    }
    const session = id === undefined ? undefined : sessions.get(id);
    if (!session || id === undefined) return json(response, 404, { message: 'Session not found' });
    if (action === undefined && request.method === 'DELETE') {
      running.get(id)?.();
      sessions.delete(id);
      response.writeHead(204).end();
      return;
    }
    if (action === 'prompt') {
      session.turns++;
      json(response, 200, { data: { id: `msg_user${session.turns}`, sessionID: id } });
      const text = (body as { text: string }).text;
      void execute(id, /<request>([\s\S]*)<\/request>/.exec(text)?.[1] ?? text, session.turns);
      return;
    }
    if (action === 'interrupt') {
      running.get(id)?.();
      return json(response, 200, { data: true });
    }
    if (action === 'permission' && subAction === 'reply') return json(response, 200, { data: true });
    return json(response, 404, { message: 'Not found' });
  });

  const heartbeat = options.heartbeatMs === undefined ? undefined : setInterval(() => {
    for (const stream of streams) stream.write(': heartbeat\n\n');
  }, options.heartbeatMs);
  heartbeat?.unref();

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    password,
    requests,
    sessions,
    streams: () => streams.size,
    addLeftover: (directory, created = Date.now() - 60_000) => {
      const sessionId = `ses_left${++nextId}`;
      sessions.set(sessionId, { body: {}, directory, created, turns: 0 });
      return sessionId;
    },
    close: async () => {
      clearInterval(heartbeat);
      for (const stream of streams) stream.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
};
