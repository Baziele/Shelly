#!/usr/bin/env node
/*
 * A stand-in for `claude -p --input-format stream-json --output-format
 * stream-json --include-partial-messages`, for tests. It speaks the same
 * NDJSON and reads what to do from the <request> of each message:
 *
 *   reply: <text>   reply with <text> (deltas, then result)
 *   slow            stream 100 deltas, 30 ms apart
 *   hang            never answer
 *   crash           write to stderr and exit 3
 *   auth            fail as a signed-out CLI does
 *   api-error       fail as an overloaded API does
 *   anything else   reply `echo pid=<pid> turn=<n>`, n counting this process's requests
 *
 * Environment: FAKE_CLAUDE_LOG (append a JSON line per event),
 * FAKE_CLAUDE_STARTUP_MS, FAKE_CLAUDE_DELTA_MS, FAKE_CLAUDE_STDERR_SPAM,
 * FAKE_CLAUDE_GRANDCHILD (start a long-lived child in the same group).
 */
import { spawn } from 'node:child_process';
import { appendFileSync, writeSync } from 'node:fs';

const env = process.env;
const log = (event) => {
  if (env.FAKE_CLAUDE_LOG) appendFileSync(env.FAKE_CLAUDE_LOG, `${JSON.stringify({ pid: process.pid, ...event })}\n`);
};
const out = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let grandchild;
if (env.FAKE_CLAUDE_GRANDCHILD) {
  grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
}
log({
  event: 'start',
  args: process.argv.slice(2),
  cwd: process.cwd(),
  hostSession: ['CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_ENTRYPOINT'].filter((name) => name in env),
  grandchild: grandchild?.pid ?? null,
});
// Blocking writes, as a native CLI's are: they stall once the pipe is full and nobody reads it.
if (env.FAKE_CLAUDE_STDERR_SPAM) for (let i = 0; i < 64; i++) writeSync(2, `${'x'.repeat(32_000)}\n`);

const startup = sleep(Number(env.FAKE_CLAUDE_STARTUP_MS ?? 0));
const deltaMs = Number(env.FAKE_CLAUDE_DELTA_MS ?? 5);
const SLOW_DELTA_MS = 30;
let turns = 0;
let current = null;
let queue = Promise.resolve();

const result = (fields) => out({ type: 'result', subtype: 'success', is_error: false, session_id: 'fake', ...fields });
const delta = (text) => out({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } });

const answer = async (content) => {
  await startup;
  turns += 1;
  const request = /<request>([\s\S]*)<\/request>/.exec(content)?.[1] ?? content;
  log({ event: 'request', turn: turns, request });
  out({ type: 'system', subtype: 'init', session_id: 'fake' });
  const turn = { interrupted: false };
  current = turn;
  const stream = async (chunks) => {
    for (const chunk of chunks) {
      if (turn.interrupted) return false;
      await sleep(chunks.length > 50 ? SLOW_DELTA_MS : deltaMs);
      if (turn.interrupted) return false;
      delta(chunk);
    }
    return true;
  };

  if (request === 'hang') return new Promise(() => {});
  if (request === 'crash') {
    process.stderr.write('Error: something broke inside the fake\n');
    process.exit(3);
  }
  if (request === 'auth') {
    out({ type: 'assistant', error: 'authentication_failed', message: { role: 'assistant', content: [{ type: 'text', text: 'Not logged in · Please run /login' }] } });
    result({ is_error: true, result: 'Not logged in · Please run /login' });
    return;
  }
  if (request === 'api-error') {
    result({ is_error: true, result: 'API Error: 529 {"type":"error","error":{"type":"overloaded_error"}}' });
    return;
  }

  const text = request.startsWith('reply: ')
    ? request.slice('reply: '.length)
    : request === 'slow' ? 'x'.repeat(100) : `echo pid=${process.pid} turn=${turns}`;
  const size = request === 'slow' ? 1 : Math.max(1, Math.ceil(text.length / 3));
  const chunks = [];
  for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size));
  if (!(await stream(chunks))) return; // the interrupt already ended the turn
  current = null;
  out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
  result({ result: text });
};

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    const message = JSON.parse(line);
    if (message.type === 'control_request' && message.request?.subtype === 'interrupt') {
      log({ event: 'interrupt' });
      out({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: {} } });
      if (current) {
        current.interrupted = true;
        current = null;
        out({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } });
        result({ subtype: 'error_during_execution', is_error: true });
      }
    } else if (message.type === 'user') {
      // One turn at a time, as the CLI queues messages sent mid-turn.
      queue = queue.then(() => answer(message.message.content));
    }
  }
});
process.stdin.on('end', () => {
  log({ event: 'stdin-end' });
  process.exit(0);
});
