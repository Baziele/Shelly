/*
 * Plays back a recorded ACP session (test/fixtures/acp/<agent>/<name>.ndjson)
 * as the agent side, so the runtime meets the real agents' exact traffic.
 *
 *   node --import tsx replay-peer.ts <fixture.ndjson>
 *
 * It walks the recording in order. An agent→client line is sent at once
 * (responses get the id the client actually used); a client→agent line waits
 * for the client to send that method (or answer that request). Recorded
 * requests the client doesn't make (the probe's own setup, such as picking a
 * model) are skipped with their responses. Timing is not replayed.
 */
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';

interface Message {
  readonly id?: number | string;
  readonly method?: string;
  readonly result?: unknown;
  readonly error?: unknown;
  readonly params?: unknown;
}
interface Line {
  readonly dir: 'in' | 'out';
  readonly msg: Message;
  readonly proc?: number;
}

const path = process.argv[2];
if (!path) {
  process.stderr.write('usage: replay-peer.ts <fixture.ndjson>\n');
  process.exit(2);
}
const recording: Line[] = readFileSync(path, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Line);

const send = (message: Message): void => {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
};

/** Recorded client request id → the id the client used. */
const clientIds = new Map<number | string, number | string>();
/** Recorded client requests skipped because the client never made them. */
const skipped = new Set<number | string>();
const inbox: Message[] = [];
let wake: (() => void) | null = null;
let closed = false;

const lines = createInterface({ input: Readable.from(process.stdin) });
lines.on('line', (line) => {
  try {
    inbox.push(JSON.parse(line) as Message);
  } catch {
    return;
  }
  wake?.();
});
lines.on('close', () => {
  closed = true;
  wake?.();
});

const next = async (): Promise<Message | null> => {
  while (inbox.length === 0) {
    if (closed) {
      return null;
    }
    await new Promise<void>((resolve) => {
      wake = resolve;
    });
    wake = null;
  }
  return inbox.shift()!;
};

const isResponse = (message: Message): boolean => message.method === undefined && message.id !== undefined;

let cursor = 0;
while (cursor < recording.length) {
  const { dir, msg } = recording[cursor]!;
  if (dir === 'in') {
    if (isResponse(msg)) {
      if (!skipped.has(msg.id!)) {
        send({ ...msg, id: clientIds.get(msg.id!) ?? msg.id! });
      }
    } else {
      send(msg);
    }
    cursor++;
    continue;
  }
  // A client→agent line: wait for the client to send it.
  const incoming = await next();
  if (incoming === null) {
    process.exit(0);
  }
  if (isResponse(msg) ? isResponse(incoming) && incoming.id === msg.id : incoming.method === msg.method) {
    if (msg.id !== undefined && !isResponse(msg)) {
      clientIds.set(msg.id, incoming.id!);
    }
    cursor++;
    continue;
  }
  // The client sent something else: skip recorded client requests until one matches.
  inbox.unshift(incoming);
  let match = -1;
  for (let i = cursor; i < recording.length; i++) {
    const candidate = recording[i]!;
    if (candidate.dir === 'out' && candidate.msg.method === incoming.method) {
      match = i;
      break;
    }
  }
  if (match === -1) {
    process.stderr.write(`replay-peer: unexpected ${incoming.method ?? 'response'} at line ${cursor + 1}\n`);
    if (incoming.method && incoming.id !== undefined) {
      inbox.shift();
      send({ id: incoming.id, error: { code: -32603, message: `replay-peer: ${incoming.method} is not in the recording` } });
    } else {
      inbox.shift();
    }
    continue;
  }
  for (let i = cursor; i < match; i++) {
    const candidate = recording[i]!;
    if (candidate.dir === 'out' && candidate.msg.id !== undefined && !isResponse(candidate.msg)) {
      skipped.add(candidate.msg.id);
    }
  }
  // Keep the agent→client lines in between, minus responses to skipped requests (handled above).
  const between = recording.slice(cursor, match).filter((line) => line.dir === 'in');
  recording.splice(cursor, match - cursor, ...between);
}
// The recording is over; answer anything else so the client never hangs.
for (;;) {
  const incoming = await next();
  if (incoming === null) {
    process.exit(0);
  }
  if (incoming.method && incoming.id !== undefined) {
    send({ id: incoming.id, result: {} });
  }
}
