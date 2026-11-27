/*
 * The runtime against the real agents. Off by default: each run sends two
 * tiny prompts per agent to a small model, which costs a little.
 *
 *   SHELLY_REAL_AGENTS=1 node --import tsx --test src/daemon/agents/real-agents.test.ts
 *
 * Claude Code runs on haiku, OpenCode on a free model. Each agent: prewarm a
 * session, one prompt ("Reply with OK"), kill the process, resume, prompt
 * again. Latencies are printed as test diagnostics.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it, type TestContext } from 'node:test';
import * as Effect from 'effect/Effect';
import * as Stream from 'effect/Stream';
import { AgentRuntime, type AgentSession, type AgentUpdate } from '../services.js';
import { findExecutable } from './definitions.js';
import { endOf, isRunning, request, run, textOf } from './testing/harness.js';
import type { AgentRuntimeOptions } from './runtime.js';

const enabled = process.env.SHELLY_REAL_AGENTS === '1';
const skip = enabled ? false : 'set SHELLY_REAL_AGENTS=1 to run against real agents';

const timed = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const started = performance.now();
    const value = yield* effect;
    return { value, ms: Math.round(performance.now() - started) };
  });

/** A turn, with the time to its first update. */
const promptTimed = (session: AgentSession, text: string) =>
  Effect.gen(function* () {
    const started = performance.now();
    let first: number | null = null;
    const updates: AgentUpdate[] = [];
    yield* session.prompt(text).pipe(Stream.runForEach((update) =>
      Effect.sync(() => {
        first ??= Math.round(performance.now() - started);
        updates.push(update);
      })));
    return { updates, firstUpdateMs: first, totalMs: Math.round(performance.now() - started) };
  });

const exercise = async (t: TestContext, agentId: 'claude' | 'opencode', options: AgentRuntimeOptions) => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), `shelly-real-${agentId}-`)));
  const pids: number[] = [];
  try {
    const report = await run({}, Effect.gen(function* () {
      const runtime = yield* AgentRuntime;
      const thread = request({ agentId, cwd, threadId: `real-${agentId}` });

      // Cold: the user opens the input; the process and session start while they type.
      const prewarmStarted = performance.now();
      yield* runtime.prewarm({ agentId, session: thread });
      const ready = yield* timed(runtime.session(thread));
      const prewarmToReadyMs = Math.round(performance.now() - prewarmStarted);
      const session = ready.value;

      const warm = yield* timed(runtime.session(thread));
      const first = yield* promptTimed(session, 'Reply with OK and nothing else.');
      // A second thread on the warm process: a new session, no prompt.
      const newOnWarmProcess = yield* timed(runtime.session({ ...thread, threadId: `real-${agentId}-2` }));
      yield* runtime.release(`real-${agentId}-2`);

      // The process dies; the next session() respawns it and resumes.
      const nativeSessionId = session.nativeSessionId;
      process.kill(-pids[0]!, 'SIGKILL');
      while (isRunning(pids[0]!) || (yield* runtime.processCount) > 0) {
        yield* Effect.sleep('20 millis');
      }
      const resumed = yield* timed(runtime.session({ ...thread, nativeSessionId }));
      const second = yield* promptTimed(resumed.value, 'Reply with OK again, nothing else.');
      return {
        prewarmToReadyMs,
        sessionWarmMs: warm.ms,
        sessionNewOnWarmProcessMs: newOnWarmProcess.ms,
        sessionResumedColdMs: resumed.ms,
        firstPrompt: { firstUpdateMs: first.firstUpdateMs, totalMs: first.totalMs },
        resumedPrompt: { firstUpdateMs: second.firstUpdateMs, totalMs: second.totalMs },
        sameSession: resumed.value.nativeSessionId === nativeSessionId,
        startedFresh: resumed.value.startedFresh,
        modes: session.modes?.availableModes.map((mode) => mode.id) ?? null,
        currentMode: session.modes?.currentModeId ?? null,
        title: first.updates.find((update) => update.type === 'title') ?? null,
        ends: [endOf(first.updates), endOf(second.updates)],
        texts: [textOf(first.updates), textOf(second.updates)],
      };
    }), { ...options, onSpawn: ({ pid }) => pids.push(pid) });
    t.diagnostic(`${agentId}: ${JSON.stringify(report)}`);
    assert.deepEqual(report.ends.map((end) => end.stopReason), ['end_turn', 'end_turn']);
    assert.match(report.texts[0]!, /OK/i);
    assert.match(report.texts[1]!, /OK/i);
    assert.equal(report.sameSession, true);
    assert.equal(report.startedFresh, false);
    for (const pid of pids) {
      assert.equal(isRunning(pid), false, `agent process ${pid} is still running`);
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
};

it('drives Claude Code: prompt, kill, resume', { skip, timeout: 180_000 }, (t) =>
  exercise(t, 'claude', { sessionDefaults: { claude: { meta: { claudeCode: { options: { model: 'haiku' } } } } } }));

it('drives OpenCode: prompt, kill, resume', {
  skip: skip || (findExecutable('opencode') === null ? 'opencode is not on PATH' : false),
  timeout: 180_000,
}, (t) => exercise(t, 'opencode', { sessionDefaults: { opencode: { configOptions: { model: 'opencode-go/hy4-flash-free' } } } }));
