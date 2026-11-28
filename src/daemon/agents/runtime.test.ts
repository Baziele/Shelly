import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import * as Effect from 'effect/Effect';
import * as Fiber from 'effect/Fiber';
import * as Logger from 'effect/Logger';
import * as References from 'effect/References';
import * as Stream from 'effect/Stream';
import { AgentRuntime, type AgentSession, type AgentSettings, type AgentUpdate } from '../services.js';
import { collect, endOf, fakeAgent, isRunning, request, run, textOf } from './testing/harness.js';

const SCENARIO = join(import.meta.dirname, 'testing', 'scenarios', 'runtime.ts');
const CONFIG_MODES = join(import.meta.dirname, 'testing', 'scenarios', 'config-modes.ts');
const TIMEOUT = { timeout: 30_000 };

const tmp = mkdtempSync(join(tmpdir(), 'shelly-agents-'));
after(() => rmSync(tmp, { recursive: true, force: true }));
let logCount = 0;

/** A fake agent that logs every client request to a fresh file. */
const logged = (quirks: Record<string, string> = {}, scenario = SCENARIO, name?: string) => {
  const log = join(tmp, `requests-${++logCount}.ndjson`);
  const agent: AgentSettings = fakeAgent(scenario, { QUIRK_LOG: log, ...quirks }, name);
  const requests = (): { method: string; params: Record<string, unknown> }[] => {
    try {
      return readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    } catch {
      return [];
    }
  };
  return { agent, requests, methods: () => requests().map((entry) => entry.method) };
};

/** Runs a turn, calling `onUpdate` for each update as it arrives (permissions need answering mid-turn). */
const drive = (
  session: AgentSession,
  text: string,
  onUpdate: (update: AgentUpdate) => Effect.Effect<void, unknown> = () => Effect.void,
) =>
  Effect.gen(function* () {
    const updates: AgentUpdate[] = [];
    yield* session.prompt(text).pipe(
      Stream.runForEach((update) => {
        updates.push(update);
        return onUpdate(update).pipe(Effect.forkDetach, Effect.asVoid);
      }),
    );
    return updates;
  });

// The bound only limits how long a failing test takes.
const waitUntil = (check: () => boolean, ms = 20_000) =>
  Effect.gen(function* () {
    const deadline = Date.now() + ms;
    while (!check()) {
      if (Date.now() > deadline) {
        return yield* Effect.die(new Error('condition not met in time'));
      }
      yield* Effect.sleep('20 millis');
    }
  });

describe('AgentRuntime processes and sessions', () => {
  it('spawns one process, initializes it as shelly, and opens a new session', TIMEOUT, async () => {
    const fake = logged();
    const pids: number[] = [];
    const result = await run({ agents: { fake: fake.agent } }, Effect.gen(function* () {
      const runtime = yield* AgentRuntime;
      const session = yield* runtime.session(request({ agentId: 'fake' }));
      const again = yield* runtime.session(request({ agentId: 'fake' }));
      return {
        id: session.nativeSessionId,
        againId: again.nativeSessionId,
        startedFresh: session.startedFresh,
        modes: session.modes,
        processes: yield* runtime.processCount,
      };
    }), { onSpawn: ({ pid }) => pids.push(pid) });
    assert.equal(result.id, 'fake-session-1');
    assert.equal(result.againId, 'fake-session-1');
    assert.equal(result.startedFresh, false);
    assert.equal(result.processes, 1);
    assert.deepEqual(result.modes?.availableModes.map((mode) => mode.id), ['default', 'plan']);
    assert.equal(pids.length, 1);
    const [initialize] = fake.requests();
    assert.equal(initialize?.method, 'initialize');
    assert.deepEqual((initialize?.params as { clientInfo: unknown }).clientInfo, { name: 'shelly', version: '0.1.0' });
    assert.deepEqual((initialize?.params as { clientCapabilities: unknown }).clientCapabilities, {
      fs: { readTextFile: false, writeTextFile: false },
      terminal: false,
      _meta: { terminal_output_delta: true },
    });
    assert.deepEqual(fake.methods(), ['initialize', 'session/new']);
    // The runtime's scope is closed: the process group is gone.
    await waitUntilAsync(() => !isRunning(pids[0]!));
  });

  it("opens sessions on the agent's configured model", TIMEOUT, async () => {
    const fake = logged();
    await run({ agents: { fake: { ...fake.agent, model: 'small' } } }, Effect.gen(function* () {
      const runtime = yield* AgentRuntime;
      yield* runtime.session(request({ agentId: 'fake' }));
    }));
    const set = fake.requests().find((entry) => entry.method === 'session/set_config_option');
    assert.deepEqual(set?.params, { sessionId: 'fake-session-1', configId: 'model', value: 'small' });
  });

  it('resumes a session with the same cwd and directories', TIMEOUT, async () => {
    const fake = logged();
    const session = await run({ agents: { fake: fake.agent } }, Effect.gen(function* () {
      const runtime = yield* AgentRuntime;
      return yield* runtime.session(request({ agentId: 'fake', nativeSessionId: 'earlier', additionalDirectories: ['/extra'] }));
    }));
    assert.equal(session.nativeSessionId, 'earlier');
    assert.equal(session.startedFresh, false);
    const resume = fake.requests().find((entry) => entry.method === 'session/resume');
    assert.equal(resume?.params.sessionId, 'earlier');
    assert.equal(resume?.params.cwd, process.cwd());
    assert.deepEqual(resume?.params.additionalDirectories, ['/extra']);
    assert.ok(!fake.methods().includes('session/new'));
  });

  it('starts fresh when the agent no longer has the session', TIMEOUT, async () => {
    const fake = logged({ QUIRK_RESUME_NOT_FOUND: '1' });
    const session = await run({ agents: { fake: fake.agent } }, Effect.gen(function* () {
      const runtime = yield* AgentRuntime;
      const session = yield* runtime.session(request({ agentId: 'fake', nativeSessionId: 'gone' }));
      return { id: session.nativeSessionId, startedFresh: session.startedFresh };
    }));
    assert.equal(session.startedFresh, true);
    assert.equal(session.id, 'fake-session-1');
    assert.deepEqual(fake.methods().slice(1, 3), ['session/resume', 'session/new']);
  });

  it('says so in the turn when a released session reopens fresh behind the caller', TIMEOUT, async () => {
    const fake = logged({ QUIRK_RESUME_NOT_FOUND: '1' });
    const result = await run({ agents: { fake: fake.agent } }, Effect.gen(function* () {
      const runtime = yield* AgentRuntime;
      const session = yield* runtime.session(request({ agentId: 'fake' }));
      const first = session.nativeSessionId;
      yield* runtime.release('thread-1');
      const updates = yield* collect(session.prompt('hello'));
      return { first, now: session.nativeSessionId, updates };
    }));
    assert.equal(result.first, 'fake-session-1');
    assert.equal(result.now, 'fake-session-2');
    assert.match((result.updates[0] as { text: string }).text, /couldn't resume the earlier conversation/);
    assert.equal(textOf(result.updates), 'hello');
  });

  it('closes idle sessions, stops the idle process, and resumes on the next use', TIMEOUT, async () => {
    const fake = logged();
    const pids: number[] = [];
    const result = await run({ agents: { fake: fake.agent } }, Effect.gen(function* () {
      const runtime = yield* AgentRuntime;
      const session = yield* runtime.session(request({ agentId: 'fake' }));
      yield* waitUntil(() => pids.length === 1 && !isRunning(pids[0]!));
      const afterIdle = yield* runtime.processCount;
      // The old handle still works: it resumes on a new process.
      const updates = yield* collect(session.prompt('hello again'));
      return { afterIdle, updates, id: session.nativeSessionId };
    }), {
      onSpawn: ({ pid }) => pids.push(pid),
      envOverrides: { SHELLY_AGENT_SESSION_IDLE_MS: '150', SHELLY_AGENT_PROCESS_IDLE_MS: '150' },
    });
    assert.equal(result.afterIdle, 0);
    assert.equal(textOf(result.updates), 'hello again');
    assert.equal(result.id, 'fake-session-1');
    assert.equal(pids.length, 2);
    const methods = fake.methods();
    assert.deepEqual(methods.slice(0, 3), ['initialize', 'session/new', 'session/close']);
    const resume = fake.requests().find((entry) => entry.method === 'session/resume');
    assert.equal(resume?.params.sessionId, 'fake-session-1');
  });

  it('marks sessions lost when the process dies, then respawns and resumes', TIMEOUT, async () => {
    const fake = logged({ QUIRK_CRASH_ON: 'crash' });
    const pids: number[] = [];
    const result = await run({ agents: { fake: fake.agent } }, Effect.gen(function* () {
      const runtime = yield* AgentRuntime;
      const session = yield* runtime.session(request({ agentId: 'fake' }));
      const crashed = yield* collect(session.prompt('please crash now'));
      yield* waitUntil(() => !isRunning(pids[0]!));
      // The runtime hears of the exit when the connection ends, a moment after the pid goes.
      let processes = yield* runtime.processCount;
      for (let tries = 0; processes > 0 && tries < 2_000; tries++) {
        yield* Effect.sleep('10 millis');
        processes = yield* runtime.processCount;
      }
      const again = yield* runtime.session(request({ agentId: 'fake', nativeSessionId: session.nativeSessionId }));
      const updates = yield* collect(again.prompt('still there?'));
      return { crashed, processes, updates, id: again.nativeSessionId, startedFresh: again.startedFresh };
    }), { onSpawn: ({ pid }) => pids.push(pid) });
    const end = endOf(result.crashed);
    assert.equal(end.stopReason, 'error');
    assert.equal(end.error, 'fake stopped unexpectedly.');
    assert.equal(result.processes, 0);
    assert.equal(pids.length, 2);
    assert.equal(result.id, 'fake-session-1');
    assert.equal(result.startedFresh, false);
    assert.equal(textOf(result.updates), 'still there?');
  });

  it('keeps working while the agent floods stderr', TIMEOUT, async () => {
    const fake = logged({ QUIRK_STDERR_FLOOD_BYTES: String(4 * 1024 * 1024) });
    const updates = await run({ agents: { fake: fake.agent } }, Effect.gen(function* () {
      const runtime = yield* AgentRuntime;
      const session = yield* runtime.session(request({ agentId: 'fake' }));
      return yield* collect(session.prompt('noisy'));
    }));
    assert.equal(textOf(updates), 'noisy');
  });

  it('prewarms once while in flight, and session() joins the warm-up', TIMEOUT, async () => {
    const fake = logged();
    const pids: number[] = [];
    const result = await run({ agents: { fake: fake.agent } }, Effect.gen(function* () {
      const runtime = yield* AgentRuntime;
      const sessionRequest = request({ agentId: 'fake' });
      yield* runtime.prewarm({ agentId: 'fake', session: sessionRequest });
      yield* runtime.prewarm({ agentId: 'fake', session: sessionRequest });
      yield* runtime.prewarm({ agentId: 'fake', session: null });
      // Prewarm returns before anything is up: no agent initializes that fast.
      const upWhenReturned = yield* runtime.processCount;
      const session = yield* runtime.session(sessionRequest);
      return { upWhenReturned, id: session.nativeSessionId };
    }), { onSpawn: ({ pid }) => pids.push(pid) });
    assert.equal(result.upWhenReturned, 0, 'prewarm waited for the agent to start');
    assert.equal(pids.length, 1);
    assert.equal(result.id, 'fake-session-1');
    assert.deepEqual(fake.methods(), ['initialize', 'session/new']);
  });

  it('prewarms only the process when given no session', TIMEOUT, async () => {
    const fake = logged();
    const count = await run({ agents: { fake: fake.agent } }, Effect.gen(function* () {
      const runtime = yield* AgentRuntime;
      yield* runtime.prewarm({ agentId: 'fake', session: null });
      // Up once initialize is answered, not when the agent receives it.
      let count = 0;
      while (count === 0) {
        yield* Effect.sleep('10 millis');
        count = yield* runtime.processCount;
      }
      return count;
    }));
    assert.equal(count, 1);
    assert.deepEqual(fake.methods(), ['initialize']);
  });

  it('re-resumes in place when the directories change, for agents that replace live sessions', TIMEOUT, async () => {
    const fake = logged();
    const id = await run({ agents: { claude: { ...fake.agent, name: 'Claude Code' } } }, Effect.gen(function* () {
      const runtime = yield* AgentRuntime;
      yield* runtime.session(request({ agentId: 'claude', additionalDirectories: ['/one'] }));
      const moved = yield* runtime.session(request({ agentId: 'claude', additionalDirectories: ['/two'] }));
      return moved.nativeSessionId;
    }));
    assert.equal(id, 'fake-session-1');
    assert.deepEqual(fake.methods(), ['initialize', 'session/new', 'session/resume']);
    const resume = fake.requests().find((entry) => entry.method === 'session/resume');
    assert.deepEqual(resume?.params.additionalDirectories, ['/two']);
  });

  it('closes and resumes when the directories change, for other agents', TIMEOUT, async () => {
    const fake = logged();
    await run({ agents: { fake: fake.agent } }, Effect.gen(function* () {
      const runtime = yield* AgentRuntime;
      yield* runtime.session(request({ agentId: 'fake', additionalDirectories: ['/one'] }));
      yield* runtime.session(request({ agentId: 'fake', additionalDirectories: ['/two'] }));
    }));
    assert.deepEqual(fake.methods(), ['initialize', 'session/new', 'session/close', 'session/resume']);
  });

  it('release closes the session now', TIMEOUT, async () => {
    const fake = logged();
    await run({ agents: { fake: fake.agent } }, Effect.gen(function* () {
      const runtime = yield* AgentRuntime;
      yield* runtime.session(request({ agentId: 'fake' }));
      yield* runtime.release('thread-1');
    }));
    assert.deepEqual(fake.methods(), ['initialize', 'session/new', 'session/close']);
  });

  it('fails with AgentUnavailable for unknown, disabled and missing agents', TIMEOUT, async () => {
    const errors = await run({
      agents: { off: { command: process.execPath, enabled: false }, missing: { command: 'shelly-no-such-agent' } },
    }, Effect.gen(function* () {
      const runtime = yield* AgentRuntime;
      const reasons: string[] = [];
      for (const agentId of ['nobody', 'off', 'missing']) {
        const error = yield* Effect.flip(runtime.session(request({ agentId })));
        assert.equal(error._tag, 'AgentUnavailable');
        reasons.push(error.reason);
      }
      return reasons;
    }));
    assert.match(errors[0]!, /doesn't know an agent called “nobody”/);
    assert.match(errors[1]!, /doesn't know an agent called “off”/);
    assert.match(errors[2]!, /isn't installed: `shelly-no-such-agent` isn't on your PATH/);
  });
});

describe('AgentRuntime turns', () => {
  it('maps every update kind and ignores the rest', TIMEOUT, async () => {
    const fake = logged();
    const result = await run({ agents: { fake: fake.agent } }, Effect.gen(function* () {
      const runtime = yield* AgentRuntime;
      const session = yield* runtime.session(request({ agentId: 'fake' }));
      const updates = yield* collect(session.prompt('updates please'));
      return { updates, modes: session.modes };
    }));
    const types = result.updates.map((update) => update.type);
    assert.deepEqual(types, ['chunk', 'title', 'plan', 'tool', 'tool', 'tool', 'tool', 'tool', 'mode', 'chunk', 'end']);
    assert.equal(textOf(result.updates, 'thought'), 'thinking');
    assert.equal(textOf(result.updates), 'done');
    const updates = result.updates;
    assert.deepEqual(updates[1], { type: 'title', title: 'A generated title' });
    assert.deepEqual(updates[2], { type: 'plan', entries: [{ content: 'Step one', priority: 'high', status: 'in_progress' }] });

    const tools = updates.flatMap((update) => update.type === 'tool' ? [update.tool] : []);
    assert.deepEqual(tools.slice(0, 3).map((tool) => tool.status), ['pending', 'in_progress', 'completed']);
    const read = tools[2]!;
    assert.equal(read.title, 'Read big.txt');
    assert.equal(read.kind, 'read');
    assert.deepEqual(read.locations, [{ path: '/work/big.txt', line: 3 }]);
    const text = read.content[0];
    assert.ok(text?.type === 'text' && text.truncated && text.text.endsWith('line 1999') && text.text.length <= 8 * 1024);

    const edit = tools[4]!;
    assert.equal(edit.status, 'failed');
    assert.equal(edit.title, 'Edit big.txt (failed)');
    const diff = edit.content[0];
    assert.ok(diff?.type === 'diff' && diff.truncated);
    assert.ok(diff.oldText !== null && diff.oldText.split('\n').length <= 200);
    assert.match(diff.newText, /row 500 changed/);

    assert.deepEqual(updates[8], {
      type: 'mode',
      currentModeId: 'plan',
      availableModes: [
        { id: 'default', name: 'Default', description: 'Ask first' },
        { id: 'plan', name: 'Plan', description: null },
      ],
    });
    assert.equal(result.modes?.currentModeId, 'plan');
    assert.deepEqual(endOf(updates), { type: 'end', stopReason: 'end_turn', error: null });
  });

  it('passes stop reasons through', TIMEOUT, async () => {
    const fake = logged();
    const updates = await run({ agents: { fake: fake.agent } }, Effect.gen(function* () {
      const runtime = yield* AgentRuntime;
      const session = yield* runtime.session(request({ agentId: 'fake' }));
      return yield* collect(session.prompt('refuse this'));
    }));
    assert.equal(endOf(updates).stopReason, 'refusal');
  });

  for (const [option, expected] of [['allow-once', 'allowed'], ['reject-once', 'rejected']] as const) {
    it(`waits for a permission answer (${option})`, TIMEOUT, async () => {
      const fake = logged();
      const updates = await run({ agents: { fake: fake.agent } }, Effect.gen(function* () {
        const runtime = yield* AgentRuntime;
        const session = yield* runtime.session(request({ agentId: 'fake' }));
        return yield* drive(session, 'permission please', (update) =>
          update.type === 'permission' ? session.respond(update.requestId, option) : Effect.void);
      }));
      const permission = updates.find((update) => update.type === 'permission');
      assert.ok(permission?.type === 'permission');
      assert.equal(permission.title, 'Write a.txt');
      assert.equal(permission.toolCallId, 'write-a');
      assert.deepEqual(permission.options.map((choice) => [choice.optionId, choice.kind]), [
        ['allow-once', 'allow_once'],
        ['allow-always', 'allow_always'],
        ['reject-once', 'reject_once'],
      ]);
      const tool = updates.find((update) => update.type === 'tool');
      assert.ok(tool?.type === 'tool' && tool.tool.content[0]?.type === 'diff');
      assert.ok(updates.indexOf(tool) < updates.indexOf(permission));
      assert.deepEqual(updates.find((update) => update.type === 'permission.resolved'), {
        type: 'permission.resolved',
        requestId: permission.requestId,
        optionId: option,
      });
      assert.equal(textOf(updates), expected);
      assert.equal(endOf(updates).stopReason, 'end_turn');
    });
  }

  it('answers a null response with the cancelled outcome', TIMEOUT, async () => {
    const fake = logged();
    const updates = await run({ agents: { fake: fake.agent } }, Effect.gen(function* () {
      const runtime = yield* AgentRuntime;
      const session = yield* runtime.session(request({ agentId: 'fake' }));
      return yield* drive(session, 'permission please', (update) =>
        update.type === 'permission' ? session.respond(update.requestId, null) : Effect.void);
    }));
    const resolved = updates.find((update) => update.type === 'permission.resolved');
    assert.ok(resolved?.type === 'permission.resolved' && resolved.optionId === null);
    assert.equal(endOf(updates).stopReason, 'cancelled');
  });

  it('rejects unknown, invalid and already-answered requests', TIMEOUT, async () => {
    const fake = logged();
    const tags = await run({ agents: { fake: fake.agent } }, Effect.gen(function* () {
      const runtime = yield* AgentRuntime;
      const session = yield* runtime.session(request({ agentId: 'fake' }));
      const results: string[] = [];
      results.push((yield* Effect.flip(session.respond('nope', 'allow-once')))._tag);
      yield* drive(session, 'permission please', (update) =>
        update.type === 'permission'
          ? Effect.gen(function* () {
            results.push((yield* Effect.flip(session.respond(update.requestId, 'not-an-option')))._tag);
            yield* session.respond(update.requestId, 'allow-once');
            results.push((yield* Effect.flip(session.respond(update.requestId, 'allow-once')))._tag);
          })
          : Effect.void);
      return results;
    }));
    assert.deepEqual(tags, ['UnknownRequest', 'UnknownRequest', 'UnknownRequest']);
  });

  it('cancels during a permission prompt: the request resolves as cancelled and the session stays usable', TIMEOUT, async () => {
    const fake = logged();
    const result = await run({ agents: { fake: fake.agent } }, Effect.gen(function* () {
      const runtime = yield* AgentRuntime;
      const session = yield* runtime.session(request({ agentId: 'fake' }));
      const updates = yield* drive(session, 'permission please', (update) =>
        update.type === 'permission' ? session.cancel : Effect.void);
      const next = yield* collect(session.prompt('after cancel'));
      return { updates, next };
    }));
    const resolved = result.updates.find((update) => update.type === 'permission.resolved');
    assert.ok(resolved?.type === 'permission.resolved' && resolved.optionId === null);
    assert.equal(endOf(result.updates).stopReason, 'cancelled');
    assert.ok(fake.methods().includes('session/cancel'));
    assert.equal(textOf(result.next), 'after cancel');
  });

  it('cancels a streaming turn', TIMEOUT, async () => {
    const fake = logged();
    const result = await run({ agents: { fake: fake.agent } }, Effect.gen(function* () {
      const runtime = yield* AgentRuntime;
      const session = yield* runtime.session(request({ agentId: 'fake' }));
      const started = Date.now();
      const updates = yield* drive(session, 'slow one', (update) => update.type === 'chunk' ? session.cancel : Effect.void);
      return { updates, ms: Date.now() - started };
    }));
    assert.equal(endOf(result.updates).stopReason, 'cancelled');
    // The scenario would run on for 30 s; the bound only says the cancel ended it.
    assert.ok(result.ms < 20_000);
  });

  it('cancels the turn when the consumer stops listening', TIMEOUT, async () => {
    const fake = logged();
    await run({ agents: { fake: fake.agent } }, Effect.gen(function* () {
      const runtime = yield* AgentRuntime;
      const session = yield* runtime.session(request({ agentId: 'fake' }));
      yield* session.prompt('slow one').pipe(Stream.take(1), Stream.runDrain);
      yield* waitUntil(() => fake.methods().includes('session/cancel'));
    }));
  });

  it('refuses a second prompt while a turn runs', TIMEOUT, async () => {
    const fake = logged();
    const second = await run({ agents: { fake: fake.agent } }, Effect.gen(function* () {
      const runtime = yield* AgentRuntime;
      const session = yield* runtime.session(request({ agentId: 'fake' }));
      const first = yield* session.prompt('slow one').pipe(Stream.runDrain, Effect.forkChild);
      yield* waitUntil(() => fake.methods().includes('session/prompt'));
      const second = yield* collect(session.prompt('again'));
      yield* session.cancel;
      yield* Fiber.join(first);
      return second;
    }));
    assert.deepEqual(second, [{ type: 'end', stopReason: 'error', error: 'The agent is still working on the last request.' }]);
  });

  it('turns authRequired into a sign-in message', TIMEOUT, async () => {
    const fake = logged();
    const updates = await run({ agents: { claude: fake.agent } }, Effect.gen(function* () {
      const runtime = yield* AgentRuntime;
      const session = yield* runtime.session(request({ agentId: 'claude' }));
      return yield* collect(session.prompt('auth'));
    }));
    assert.deepEqual(endOf(updates), {
      type: 'end',
      stopReason: 'error',
      error: "Claude Code isn't signed in. Run `claude` once to sign in.",
    });
  });

  it('shortens other agent errors to their first line', TIMEOUT, async () => {
    const fake = logged();
    const updates = await run({ agents: { fake: fake.agent } }, Effect.gen(function* () {
      const runtime = yield* AgentRuntime;
      const session = yield* runtime.session(request({ agentId: 'fake' }));
      return yield* collect(session.prompt('broken'));
    }));
    assert.equal(endOf(updates).error, 'fake failed: Internal error: the model went away');
  });

  it("reports OpenCode's cancelled-after-reject as a normal end with a notice", TIMEOUT, async () => {
    const fake = logged();
    const updates = await run({ agents: { opencode: fake.agent } }, Effect.gen(function* () {
      const runtime = yield* AgentRuntime;
      const session = yield* runtime.session(request({ agentId: 'opencode' }));
      return yield* drive(session, 'opencode-reject', (update) =>
        update.type === 'permission' ? session.respond(update.requestId, 'reject-once') : Effect.void);
    }));
    assert.deepEqual(updates.at(-2), { type: 'notice', level: 'info', text: 'Rejected: Write a.txt' });
    assert.deepEqual(endOf(updates), { type: 'end', stopReason: 'end_turn', error: null });
  });

  it('keeps cancelled after a reject for agents without that quirk, and after a real cancel', TIMEOUT, async () => {
    const fake = logged();
    const result = await run({ agents: { fake: fake.agent, opencode: fake.agent } }, Effect.gen(function* () {
      const runtime = yield* AgentRuntime;
      const plain = yield* runtime.session(request({ agentId: 'fake' }));
      const rejected = yield* drive(plain, 'opencode-reject', (update) =>
        update.type === 'permission' ? plain.respond(update.requestId, 'reject-once') : Effect.void);
      const opencode = yield* runtime.session(request({ agentId: 'opencode', threadId: 'thread-2' }));
      const cancelled = yield* drive(opencode, 'opencode-reject', (update) =>
        update.type === 'permission' ? opencode.cancel : Effect.void);
      return { rejected, cancelled };
    }));
    assert.equal(endOf(result.rejected).stopReason, 'cancelled');
    assert.equal(endOf(result.cancelled).stopReason, 'cancelled');
    assert.ok(!result.cancelled.some((update) => update.type === 'notice'));
  });
});

describe('AgentRuntime command output', () => {
  it('shows command output as tool text, and never logs it', TIMEOUT, async () => {
    const fake = logged();
    const lines: string[] = [];
    const capture = Logger.make((entry) => {
      const annotations = entry.fiber.getRef(References.CurrentLogAnnotations);
      lines.push(JSON.stringify({ message: entry.message, annotations }), String(entry.cause));
    });
    const updates = await run({ agents: { fake: fake.agent } }, Effect.gen(function* () {
      const runtime = yield* AgentRuntime;
      const session = yield* runtime.session(request({ agentId: 'fake' }));
      return yield* collect(session.prompt('please run a command'));
    }).pipe(Effect.provideService(References.MinimumLogLevel, 'All')), {
      provide: Logger.layer([capture]),
      envOverrides: { SHELLY_AGENT_SESSION_IDLE_MS: '50', SHELLY_AGENT_PROCESS_IDLE_MS: '50' },
    });
    const tool = updates.findLast((update) => update.type === 'tool');
    assert.ok(tool?.type === 'tool');
    assert.equal(tool.tool.status, 'failed');
    assert.deepEqual(tool.tool.content, [{
      type: 'text',
      // Raw terminal text: the client sanitises it before drawing.
      text: 'OUTPUT-MARKER line one\n\u001b[31mOUTPUT-MARKER failed\u001b[0m\nExit code 2',
      truncated: false,
    }]);
    assert.ok(lines.length > 0, 'the capturing logger saw nothing');
    assert.ok(!lines.some((line) => line.includes('OUTPUT-MARKER')), 'command output reached the logs');
  });
});

describe('AgentRuntime modes', () => {
  it('switches ACP modes with session/set_mode and shows the change in the next turn', TIMEOUT, async () => {
    const fake = logged();
    const result = await run({ agents: { fake: fake.agent } }, Effect.gen(function* () {
      const runtime = yield* AgentRuntime;
      const session = yield* runtime.session(request({ agentId: 'fake' }));
      yield* session.setMode('plan');
      const missing = yield* Effect.flip(session.setMode('nope'));
      const updates = yield* collect(session.prompt('hi'));
      return { modes: session.modes, missing, updates };
    }));
    assert.equal(result.modes?.currentModeId, 'plan');
    assert.equal(result.missing._tag, 'AgentFailed');
    assert.match(result.missing.reason, /has no mode “nope”/);
    const setMode = fake.requests().find((entry) => entry.method === 'session/set_mode');
    assert.equal(setMode?.params.modeId, 'plan');
    assert.equal(result.updates[0]?.type, 'mode');
    assert.equal((result.updates[0] as { currentModeId: string }).currentModeId, 'plan');
  });

  it('treats a mode config option as the modes, and switches it with set_config_option', TIMEOUT, async () => {
    const fake = logged({}, CONFIG_MODES);
    const result = await run({ agents: { fake: fake.agent } }, Effect.gen(function* () {
      const runtime = yield* AgentRuntime;
      const session = yield* runtime.session(request({ agentId: 'fake' }));
      const before = session.modes;
      yield* session.setMode('plan');
      return { before, after: session.modes };
    }));
    assert.deepEqual(result.before, {
      currentModeId: 'build',
      availableModes: [
        { id: 'build', name: 'Build', description: 'Does the work' },
        { id: 'plan', name: 'Plan', description: null },
      ],
    });
    assert.equal(result.after?.currentModeId, 'plan');
    const set = fake.requests().find((entry) => entry.method === 'session/set_config_option');
    assert.deepEqual([set?.params.configId, set?.params.value], ['mode', 'plan']);
  });
});

async function waitUntilAsync(check: () => boolean, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error('condition not met in time');
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
