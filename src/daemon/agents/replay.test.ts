import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as Effect from 'effect/Effect';
import * as Stream from 'effect/Stream';
import { AgentRuntime, type AgentSession, type AgentUpdate } from '../services.js';
import { endOf, replayAgent, request, run, textOf } from './testing/harness.js';

/*
 * The runtime against the real agents' recorded traffic (test/fixtures/acp),
 * played back by replay-peer.ts.
 */

const TIMEOUT = { timeout: 30_000 };

const turn = (session: AgentSession, text: string, onUpdate: (update: AgentUpdate) => Effect.Effect<void, unknown>) =>
  Effect.gen(function* () {
    const updates: AgentUpdate[] = [];
    yield* session.prompt(text).pipe(Stream.runForEach((update) => {
      updates.push(update);
      return onUpdate(update).pipe(Effect.forkDetach, Effect.asVoid);
    }));
    return updates;
  });

const replay = (agentId: 'claude' | 'opencode', fixture: string, program: (session: AgentSession) => Effect.Effect<AgentUpdate[][], unknown>) =>
  run({ agents: { [agentId]: replayAgent(`${agentId}/${fixture}`) } }, Effect.gen(function* () {
    const runtime = yield* AgentRuntime;
    const session = yield* runtime.session(request({ agentId }));
    return { session, turns: yield* program(session) };
  }));

const none = () => Effect.void;

describe('replayed Claude Code sessions', () => {
  it('a read tool call, with the generated title', TIMEOUT, async () => {
    const { session, turns: [updates] } = await replay('claude', 'tool', (session) =>
      turn(session, 'read hello.txt', none).pipe(Effect.map((updates) => [updates])));
    assert.equal(session.nativeSessionId, '634bc055-2f28-46db-a5c1-beaea1103d3e');
    // The agent's own default mode (the user's setting), never one Shelly picks.
    assert.equal(session.modes?.currentModeId, 'auto');
    assert.ok(session.modes?.availableModes.some((mode) => mode.id === 'bypassPermissions'));
    const tools = updates!.flatMap((update) => update.type === 'tool' ? [update.tool] : []);
    assert.deepEqual(tools.map((tool) => [tool.title, tool.status]), [
      ['Read File', 'pending'],
      ['Read hello.txt', 'pending'],
      ['Read hello.txt', 'pending'],
      ['Read hello.txt', 'completed'],
    ]);
    const last = tools.at(-1)!;
    assert.equal(last.kind, 'read');
    assert.deepEqual(last.locations, [{ path: '/tmp/probe/hello.txt', line: 1 }]);
    assert.match(last.content[0]?.type === 'text' ? last.content[0].text : '', /Hello from the ACP probe/);
    assert.ok(updates!.some((update) => update.type === 'title'));
    assert.ok(textOf(updates!).length > 0);
    assert.equal(endOf(updates!).stopReason, 'end_turn');
  });

  it('a rejected write ends the turn normally', TIMEOUT, async () => {
    const { turns: [updates] } = await replay('claude', 'permission-reject', (session) =>
      turn(session, 'write rejected.txt', (update) =>
        update.type === 'permission' ? session.respond(update.requestId, 'reject') : Effect.void,
      ).pipe(Effect.map((updates) => [updates])));
    const permission = updates!.find((update) => update.type === 'permission');
    assert.ok(permission?.type === 'permission');
    assert.equal(permission.title, 'Write rejected.txt');
    assert.deepEqual(permission.options.map((option) => option.optionId), ['allow-once', 'allow-with-updates', 'reject']);
    const tool = updates![updates!.indexOf(permission) - 1];
    assert.ok(tool?.type === 'tool' && tool.tool.content[0]?.type === 'diff');
    assert.ok(!updates!.some((update) => update.type === 'notice'));
    assert.equal(endOf(updates!).stopReason, 'end_turn');
  });

  it('cancel mid-stream, then a working turn', TIMEOUT, async () => {
    const { turns } = await replay('claude', 'cancel', (session) =>
      Effect.gen(function* () {
        let cancelled = false;
        const first = yield* turn(session, 'count', (update) => {
          if (update.type === 'chunk' && !cancelled) {
            cancelled = true;
            return session.cancel;
          }
          return Effect.void;
        });
        const second = yield* turn(session, 'again', none);
        return [first, second];
      }));
    assert.equal(endOf(turns[0]!).stopReason, 'cancelled');
    assert.equal(endOf(turns[1]!).stopReason, 'end_turn');
  });
});

describe('replayed OpenCode sessions', () => {
  it('a rejected write: OpenCode cancels the turn, Shelly reports the rejection', TIMEOUT, async () => {
    const { session, turns: [updates] } = await replay('opencode', 'permission-reject', (session) =>
      turn(session, 'write rejected.txt', (update) =>
        update.type === 'permission' ? session.respond(update.requestId, 'reject') : Effect.void,
      ).pipe(Effect.map((updates) => [updates])));
    // OpenCode has no ACP modes: its agents come as the mode config option.
    assert.ok(session.modes?.availableModes.some((mode) => mode.id === 'build'));
    const tool = updates!.findLast((update) => update.type === 'tool');
    assert.ok(tool?.type === 'tool' && tool.tool.status === 'failed');
    assert.deepEqual(updates!.at(-2), { type: 'notice', level: 'info', text: 'Rejected: rejected.txt' });
    assert.deepEqual(endOf(updates!), { type: 'end', stopReason: 'end_turn', error: null });
  });

  it('thoughts, cancel, then a working turn', TIMEOUT, async () => {
    const { turns } = await replay('opencode', 'cancel', (session) =>
      Effect.gen(function* () {
        let cancelled = false;
        const first = yield* turn(session, 'count', (update) => {
          if (update.type === 'chunk' && update.kind === 'text' && !cancelled) {
            cancelled = true;
            return session.cancel;
          }
          return Effect.void;
        });
        const second = yield* turn(session, 'again', none);
        return [first, second];
      }));
    assert.ok(textOf(turns[0]!, 'thought').length > 0);
    assert.equal(endOf(turns[0]!).stopReason, 'cancelled');
    assert.ok(!turns[0]!.some((update) => update.type === 'notice'));
    assert.equal(endOf(turns[1]!).stopReason, 'end_turn');
  });
});
