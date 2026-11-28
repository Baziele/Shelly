import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import * as Effect from 'effect/Effect';
import { AgentRuntime } from '../services.js';
import { fakeAgent, isRunning, request, run } from './testing/harness.js';
import { eventually, manualTimers } from './testing/manual-timers.js';

/*
 * Process and session lifetimes: hung shutdowns, and prewarm keeping things
 * warm. Idle timers are fired by hand, and the assertions are about which
 * timers wait, so a loaded machine can slow these tests but not fail them.
 */

const SCENARIO = join(import.meta.dirname, 'testing', 'scenarios', 'runtime.ts');
const IGNORE_SIGTERM = join(import.meta.dirname, 'testing', 'ignore-sigterm.mjs');
// Labels for the hand-fired timers: which wait is a session's, which a process's.
const SESSION_IDLE = 1111;
const PROCESS_IDLE = 2222;
const IDLE_ENV = { SHELLY_AGENT_SESSION_IDLE_MS: String(SESSION_IDLE), SHELLY_AGENT_PROCESS_IDLE_MS: String(PROCESS_IDLE) };

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
  it('an agent that ignores SIGTERM neither blocks the next session nor the runtime shutdown', { timeout: 90_000 }, async () => {
    const agent = fakeAgent(SCENARIO);
    const hung = { ...agent, args: ['--import', IGNORE_SIGTERM, ...(agent.args ?? [])] };
    const timers = manualTimers();
    const pids: number[] = [];
    const outcome = await Promise.race([
      run({ agents: { fake: hung } }, Effect.gen(function* () {
        const runtime = yield* AgentRuntime;
        yield* runtime.session(request({ agentId: 'fake', threadId: 't1' }));
        // The session idles out, then its process: whose SIGTERM is ignored.
        yield* eventually(() => timers.waiting(SESSION_IDLE).length === 1, 'the session idle timer');
        timers.waiting(SESSION_IDLE)[0]!.fire();
        yield* eventually(() => timers.waiting(PROCESS_IDLE).length === 1, 'the process idle timer');
        timers.waiting(PROCESS_IDLE)[0]!.fire();
        yield* eventually(() => pids.length === 1, 'the first process');
        while ((yield* runtime.processCount) > 0) {
          yield* Effect.sleep('10 millis');
        }
        // The old process is still dying. A new session must not wait for it.
        const second = yield* runtime.session(request({ agentId: 'fake', threadId: 't2' })).pipe(
          Effect.timeoutOption('30 seconds'),
        );
        return { secondOpened: second._tag === 'Some', firstStillRunning: isRunning(pids[0]!) };
      }), { envOverrides: IDLE_ENV, sleep: timers.sleep, onSpawn: ({ pid }) => pids.push(pid) }),
      // Without the force-kill, shutdown waits on the hung process forever.
      new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 60_000)),
    ]);
    const survivors = pids.filter(isRunning);
    killGroups(pids);
    assert.notEqual(outcome, 'hung', 'the runtime never finished');
    assert.ok(outcome !== 'hung' && outcome.secondOpened, 'the second session never opened');
    assert.equal(outcome.firstStillRunning, true, 'the first process exited on SIGTERM: the test agent no longer hangs');
    assert.equal(pids.length, 2);
    assert.deepEqual(survivors, [], 'hung agent processes outlived the runtime');
  });

  it('a prewarm restarts the idle countdown of a process with no sessions', { timeout: 60_000 }, async () => {
    const timers = manualTimers();
    const result = await run({ agents: { fake: fakeAgent(SCENARIO) } }, Effect.gen(function* () {
      const runtime = yield* AgentRuntime;
      yield* runtime.prewarm({ agentId: 'fake', session: null });
      yield* eventually(() => timers.waiting(PROCESS_IDLE).length === 1, 'the process idle timer');
      const first = timers.waiting(PROCESS_IDLE)[0]!;
      yield* runtime.prewarm({ agentId: 'fake', session: null }); // the user starts typing again
      yield* eventually(() => first.done() && timers.waiting(PROCESS_IDLE).length === 1, 'a restarted process idle timer');
      const restarted = timers.waiting(PROCESS_IDLE)[0]!;
      first.fire(); // too late: it was replaced
      const kept = yield* runtime.processCount;
      restarted.fire();
      while ((yield* runtime.processCount) > 0) {
        yield* Effect.sleep('10 millis');
      }
      return { firstInterrupted: first.interrupted(), kept };
    }), { envOverrides: IDLE_ENV, sleep: timers.sleep });
    assert.equal(result.firstInterrupted, true);
    assert.equal(result.kept, 1);
  });

  it('a prewarm restarts the idle countdown of a live session', { timeout: 60_000 }, async () => {
    const log = join(tmp, 'prewarm-session.ndjson');
    const methods = () => {
      try {
        return readFileSync(log, 'utf8').trim().split('\n').map((line) => (JSON.parse(line) as { method: string }).method);
      } catch {
        return [];
      }
    };
    const timers = manualTimers();
    const result = await run({ agents: { fake: fakeAgent(SCENARIO, { QUIRK_LOG: log }) } }, Effect.gen(function* () {
      const runtime = yield* AgentRuntime;
      const thread = request({ agentId: 'fake', threadId: 't1' });
      const session = yield* runtime.session(thread);
      yield* eventually(() => timers.waiting(SESSION_IDLE).length === 1, 'the session idle timer');
      const first = timers.waiting(SESSION_IDLE)[0]!;
      yield* runtime.prewarm({ agentId: 'fake', session: thread });
      yield* eventually(() => first.done() && timers.waiting(SESSION_IDLE).length === 1, 'a restarted session idle timer');
      const again = yield* runtime.session(thread);
      const before = methods();
      // The session's latest timer (session() restarted it too) still closes it.
      yield* eventually(() => timers.waiting(SESSION_IDLE).length === 1, 'the session idle timer after session()');
      timers.waiting(SESSION_IDLE)[0]!.fire();
      yield* eventually(() => methods().includes('session/close'), 'the session to close');
      return { first: session.nativeSessionId, again: again.nativeSessionId, firstInterrupted: first.interrupted(), before };
    }), { envOverrides: { ...IDLE_ENV, SHELLY_AGENT_PROCESS_IDLE_MS: '60000' }, sleep: timers.sleep });
    assert.equal(result.firstInterrupted, true);
    assert.equal(result.again, result.first);
    assert.deepEqual(result.before, ['initialize', 'session/new'], 'the session closed and was resumed despite the prewarm');
  });
});
