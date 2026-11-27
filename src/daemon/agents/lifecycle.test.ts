import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import * as Effect from 'effect/Effect';
import { AgentRuntime } from '../services.js';
import { fakeAgent, isRunning, request, run } from './testing/harness.js';

/* Process and session lifetimes: hung shutdowns, and prewarm keeping things warm. */

const SCENARIO = join(import.meta.dirname, 'testing', 'scenarios', 'runtime.ts');
const IGNORE_SIGTERM = join(import.meta.dirname, 'testing', 'ignore-sigterm.mjs');

const tmp = mkdtempSync(join(tmpdir(), 'shelly-lifecycle-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

const killGroups = (pids: readonly number[]): void => {
  for (const pid of pids) {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
};

describe('agent process lifetimes', () => {
  it('an agent that ignores SIGTERM neither blocks the next session nor the runtime shutdown', { timeout: 30_000 }, async () => {
    const agent = fakeAgent(SCENARIO);
    const hung = { ...agent, args: ['--import', IGNORE_SIGTERM, ...(agent.args ?? [])] };
    const pids: number[] = [];
    const started = Date.now();
    const outcome = await Promise.race([
      run({ agents: { fake: hung } }, Effect.gen(function* () {
        const runtime = yield* AgentRuntime;
        yield* runtime.session(request({ agentId: 'fake', threadId: 't1' }));
        // The session idles out after 100 ms, the process 100 ms later: its SIGTERM is ignored.
        yield* Effect.sleep('1 second');
        const opening = Date.now();
        const second = yield* runtime.session(request({ agentId: 'fake', threadId: 't2' })).pipe(
          Effect.timeoutOption('5 seconds'),
        );
        return { secondOpened: second._tag === 'Some', waitedMs: Date.now() - opening };
      }), {
        envOverrides: { SHELLY_AGENT_SESSION_IDLE_MS: '100', SHELLY_AGENT_PROCESS_IDLE_MS: '100' },
        onSpawn: ({ pid }) => pids.push(pid),
      }),
      new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 20_000)),
    ]);
    const tookMs = Date.now() - started;
    const survivors = pids.filter(isRunning);
    killGroups(pids);
    assert.notEqual(outcome, 'hung', 'the runtime never finished');
    assert.ok(outcome !== 'hung' && outcome.secondOpened, 'the second session never opened');
    assert.ok(outcome.waitedMs < 3_000, `the second session waited ${outcome.waitedMs} ms`);
    assert.equal(pids.length, 2);
    // Shutdown force-kills both hung processes: about 3 s of grace, in parallel.
    assert.ok(tookMs < 12_000, `the runtime took ${tookMs} ms`);
    assert.deepEqual(survivors, [], 'hung agent processes outlived the runtime');
  });

  it('a prewarm restarts the idle countdown of a process with no sessions', { timeout: 30_000 }, async () => {
    const pids: number[] = [];
    const processes = await run({ agents: { fake: fakeAgent(SCENARIO) } }, Effect.gen(function* () {
      const runtime = yield* AgentRuntime;
      yield* runtime.prewarm({ agentId: 'fake', session: null });
      while ((yield* runtime.processCount) === 0) {
        yield* Effect.sleep('10 millis');
      }
      // Up, with its 1.5 s idle countdown running.
      yield* Effect.sleep('1 second');
      yield* runtime.prewarm({ agentId: 'fake', session: null }); // the user starts typing
      yield* Effect.sleep('900 millis'); // and sends 0.9 s later, past the first countdown
      return yield* runtime.processCount;
    }), { envOverrides: { SHELLY_AGENT_PROCESS_IDLE_MS: '1500' }, onSpawn: ({ pid }) => pids.push(pid) });
    assert.equal(processes, 1, 'the process exited right after a prewarm');
    assert.equal(pids.length, 1);
  });

  it('a prewarm restarts the idle countdown of a live session', { timeout: 30_000 }, async () => {
    const log = join(tmp, 'prewarm-session.ndjson');
    const result = await run({ agents: { fake: fakeAgent(SCENARIO, { QUIRK_LOG: log }) } }, Effect.gen(function* () {
      const runtime = yield* AgentRuntime;
      const thread = request({ agentId: 'fake', threadId: 't1' });
      const session = yield* runtime.session(thread);
      yield* Effect.sleep('1 second');
      yield* runtime.prewarm({ agentId: 'fake', session: thread });
      yield* Effect.sleep('800 millis');
      const again = yield* runtime.session(thread);
      return { first: session.nativeSessionId, again: again.nativeSessionId };
    }), { envOverrides: { SHELLY_AGENT_SESSION_IDLE_MS: '1500', SHELLY_AGENT_PROCESS_IDLE_MS: '60000' } });
    assert.equal(result.again, result.first);
    const methods = readFileSync(log, 'utf8').trim().split('\n').map((line) => (JSON.parse(line) as { method: string }).method);
    assert.deepEqual(methods, ['initialize', 'session/new'], 'the session closed and was resumed despite the prewarm');
  });
});
