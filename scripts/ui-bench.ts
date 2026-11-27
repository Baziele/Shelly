/*
 * Measures the agent view while text streams fast: CPU per frame, frames
 * painted, bytes written, time to first paint and memory. Renders into an
 * emulated terminal, so it needs no tty.
 *
 *   node --experimental-ffi --no-warnings --import tsx scripts/ui-bench.ts [cols] [rows]
 */
import { setTimeout as sleep } from 'node:timers/promises';
import type { ThreadEvent } from '../src/protocol/schema.js';
import { AgentView } from '../src/ui/agent/agent-view.js';
import { loadFixture } from '../test/fixtures/thread-events/load.js';

const cols = Number(process.argv[2] ?? 100);
const rows = Number(process.argv[3] ?? 30);
let bytes = 0;
const host = {
  size: { cols, rows },
  write: (data: string) => {
    bytes += data.length;
  },
  queryCursorPosition: async () => ({ row: rows, col: 1 }),
};

const fixture = loadFixture('long-answer');
const stream = fixture.steps.flatMap((step) => ('stream' in step ? [step.stream.text] : [])).join('');
// Many small chunks, faster than any frame rate: 4 characters every 2 ms (~2000 chars/s).
const chunks = stream.match(/[\s\S]{1,4}/g) ?? [];

const rssBefore = process.memoryUsage().rss;
const constructStart = performance.now();
const view = new AgentView(host, 'truecolor', { agentName: 'claude', cwd: fixture.cwd, home: fixture.home });
const constructMs = performance.now() - constructStart;
const startedAt = performance.now();
view.start({ row: 2, col: 1 });
view.apply({ seq: 1, type: 'turn.started', turnId: 't', text: fixture.prompt, at: Date.now() });

// Time to first paint: the first write after start.
const firstPaint = await new Promise<number>((resolve) => {
  const original = host.write;
  host.write = (data) => {
    original(data);
    host.write = original;
    resolve(performance.now() - startedAt);
  };
});

const cpuStart = process.cpuUsage();
const wallStart = performance.now();
let seq = 2;
for (const text of chunks) {
  view.apply({ seq: seq++, type: 'message.chunk', turnId: 't', messageId: 'm', kind: 'text', text } as ThreadEvent);
  await sleep(2);
}
view.apply({ seq: seq++, type: 'turn.ended', turnId: 't', stopReason: 'end_turn', error: null, durationMs: 1 } as ThreadEvent);
await view.finish();
const wallMs = performance.now() - wallStart;
const cpu = process.cpuUsage(cpuStart);
const cpuMs = (cpu.user + cpu.system) / 1000;
const stats = view.renderStats;
const rssAfter = process.memoryUsage().rss;
view.destroy();

console.log(JSON.stringify({
  terminal: `${cols}x${rows}`,
  streamed: { characters: stream.length, chunks: chunks.length, wallMs: Math.round(wallMs) },
  frames: stats.frames,
  framesPerSecond: Math.round((stats.frames / wallMs) * 1000),
  cpuMsTotal: Math.round(cpuMs),
  cpuMsPerFrame: Number((cpuMs / stats.frames).toFixed(2)),
  commitAndPaintMsPerFrame: Number(stats.averageFrameMs.toFixed(3)),
  bytesWritten: bytes,
  constructMs: Number(constructMs.toFixed(1)),
  firstPaintMs: Number(firstPaint.toFixed(1)),
  rssMb: { beforeView: Math.round(rssBefore / 1e6), afterStream: Math.round(rssAfter / 1e6) },
}, null, 2));
process.exit(0);
