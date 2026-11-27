/*
 * The fake ACP agent (test/fixtures/fake-agent) with failure modes the
 * runtime must survive, switched on by env:
 *
 *   QUIRK_SCENARIO            the fake agent scenario (name or path). Default: echo.
 *   QUIRK_STDERR_FLOOD_BYTES  write this much to stderr, blocking, at startup and before each prompt.
 *   QUIRK_RESUME_NOT_FOUND=1  answer session/resume with "Resource not found".
 *   QUIRK_CRASH_ON            exit(3) when a prompt contains this text.
 *   QUIRK_LOG                 append each request the client sends (method and params) as a JSON line.
 *
 *   node --import tsx quirk-agent.ts
 */
import { appendFileSync, writeSync } from 'node:fs';
import { Readable, Writable } from 'node:stream';
import { createInterface } from 'node:readline';
import * as acp from '@agentclientprotocol/sdk';
import { createFakeAgent, loadScenario } from '../../../../test/fixtures/fake-agent/fake-agent.js';

const env = process.env;
const flood = Number(env.QUIRK_STDERR_FLOOD_BYTES ?? 0);
const floodStderr = (): void => {
  // Synchronous writes block once the pipe is full, so an undrained stderr hangs the agent.
  const chunk = Buffer.alloc(16 * 1024, 'x\n');
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (let written = 0; written < flood;) {
    try {
      written += writeSync(2, chunk);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EAGAIN') {
        throw error;
      }
      // The pipe is full: wait for the reader, without letting the event loop run.
      Atomics.wait(pause, 0, 0, 5);
    }
  }
};

const app = createFakeAgent(await loadScenario(env.QUIRK_SCENARIO ?? 'echo'));
const toAgent = new TransformStream<Uint8Array, Uint8Array>();
const fromAgent = new TransformStream<Uint8Array, Uint8Array>();
const connection = app.connect(acp.ndJsonStream(fromAgent.writable, toAgent.readable));
void fromAgent.readable.pipeTo(Writable.toWeb(process.stdout) as WritableStream<Uint8Array>);

const writer = toAgent.writable.getWriter();
const encoder = new TextEncoder();
const reply = (message: unknown): void => {
  process.stdout.write(`${JSON.stringify(message)}\n`);
};

if (flood > 0) {
  floodStderr();
}

const lines = createInterface({ input: Readable.from(process.stdin) });
for await (const line of lines) {
  let message: { id?: number | string; method?: string; params?: { prompt?: { text?: string }[] } & Record<string, unknown> };
  try {
    message = JSON.parse(line);
  } catch {
    continue;
  }
  if (env.QUIRK_LOG && message.method) {
    appendFileSync(env.QUIRK_LOG, `${JSON.stringify({ method: message.method, params: message.params })}\n`);
  }
  if (message.method === 'session/resume' && env.QUIRK_RESUME_NOT_FOUND === '1') {
    reply({ jsonrpc: '2.0', id: message.id, error: { code: -32002, message: 'Resource not found', data: {} } });
    continue;
  }
  if (message.method === 'session/prompt') {
    const text = (message.params?.prompt ?? []).map((block) => block.text ?? '').join('\n');
    if (env.QUIRK_CRASH_ON && text.includes(env.QUIRK_CRASH_ON)) {
      writeSync(2, 'fatal: the quirk agent crashed on purpose\n');
      process.exit(3);
    }
    if (flood > 0) {
      floodStderr();
    }
  }
  await writer.write(encoder.encode(`${line}\n`));
}
await writer.close();
await connection.closed;
process.exit(0);
