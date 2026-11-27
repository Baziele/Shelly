import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import * as Effect from 'effect/Effect';
import * as Fiber from 'effect/Fiber';
import * as Layer from 'effect/Layer';
import * as Stream from 'effect/Stream';
import { AgentUnavailable } from '../protocol/errors.js';
import type { PromptContext, ThreadEvent } from '../protocol/schema.js';
import * as AgentDirectory from './AgentDirectory.js';
import * as DaemonPaths from './DaemonPaths.js';
import * as ShellyConfigFile from './ShellyConfigFile.js';
import * as ThreadStore from './store/ThreadStore.js';
import { FakeAgents } from './testing/FakeAgentRuntime.js';
import * as ThreadService from './ThreadService.js';

const homes: string[] = [];
after(() => homes.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const newHome = (): string => {
  const home = mkdtempSync(join(tmpdir(), 'shelly-threads-'));
  homes.push(home);
  return home;
};

type StoreWrapper = (store: ThreadStore.ThreadStore['Service']) => ThreadStore.ThreadStore['Service'];

const servicesLayer = (fake: FakeAgents, home: string, wrapStore: StoreWrapper = (store) => store) => {
  const paths = DaemonPaths.layer({ SHELLY_HOME: home });
  const storeLayer = Layer.effect(
    ThreadStore.ThreadStore,
    Effect.gen(function* () {
      return wrapStore(yield* ThreadStore.ThreadStore);
    }),
  ).pipe(Layer.provide(ThreadStore.layer.pipe(Layer.provide(paths))));
  const base = Layer.mergeAll(paths, fake.layer(), storeLayer);
  const config = ShellyConfigFile.layer.pipe(Layer.provide(paths));
  const directory = AgentDirectory.layer.pipe(Layer.provide(Layer.merge(base, config)));
  return ThreadService.layer.pipe(Layer.provideMerge(Layer.mergeAll(base, directory)));
};

/** Run a test body against a fresh daemon state. */
const withThreads = <A, E>(
  body: (threads: ThreadService.ThreadService['Service'], fake: FakeAgents) => Effect.Effect<A, E>,
  { fake = new FakeAgents(), home = newHome(), wrapStore }: { fake?: FakeAgents; home?: string; wrapStore?: StoreWrapper } = {},
): Promise<A> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const threads = yield* ThreadService.ThreadService;
      return yield* body(threads, fake);
    }).pipe(Effect.provide(servicesLayer(fake, home, wrapStore)), Effect.scoped),
  );

/** Holds every `session` call until `open()`: an agent that is slow to start. */
const gateSessions = (fake: FakeAgents) => {
  let open!: () => void;
  fake.sessionGate = new Promise<void>((resolve) => (open = resolve));
  return () => {
    fake.sessionGate = undefined;
    open();
  };
};

const storedEventCount = (home: string, threadId: string): number => {
  const db = ThreadStore.openDatabase(join(home, 'state.sqlite'));
  try {
    return Number((db.prepare('SELECT COUNT(*) AS n FROM thread_events WHERE thread_id = ?').get(threadId) as { n: number }).n);
  } finally {
    db.close();
  }
};

const CONTEXT: PromptContext = {
  cwd: '/work/app',
  environment: { os: 'TestOS', shell: 'zsh', shellVersion: null, terminal: null },
  commands: [],
};

const CLIENT = 'client-a';

const promptInput = (threadId: string, text: string, clientId = CLIENT) => ({ threadId, clientId, text, context: CONTEXT });

const shape = (events: readonly ThreadEvent[]) =>
  events.map((event) => {
    switch (event.type) {
      case 'message.chunk':
        return `chunk:${event.kind}:${event.text}`;
      case 'turn.ended':
        return `ended:${event.stopReason}`;
      case 'permission.requested':
      case 'permission.resolved':
        return `${event.type}:${event.requestId}`;
      default:
        return event.type;
    }
  });

/** Wait until a fiber-driven condition holds (the turn runs in its own fiber). */
const eventually = (check: () => boolean) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 200; attempt++) {
      if (check()) {
        return;
      }
      yield* Effect.sleep('5 millis');
    }
    assert.fail('condition never held');
  });

const createAttached = (threads: ThreadService.ThreadService['Service'], location: 'home' | 'folder' = 'home') =>
  Effect.gen(function* () {
    const thread = yield* threads.create({ location, cwd: '/work/app' });
    yield* threads.attach({ threadId: thread.id, clientId: CLIENT, force: false, historyTurns: 1 });
    return thread;
  });

describe('ThreadService', () => {
  it('creates home threads in Shelly\'s folder and folder threads where asked', async () => {
    const home = newHome();
    await withThreads((threads) =>
      Effect.gen(function* () {
        const inHome = yield* threads.create({ location: 'home', cwd: '/work/app' });
        assert.equal(inHome.cwd, join(home, 'home'));
        assert.equal(inHome.agentId, 'fake');
        assert.equal(inHome.status, 'idle');
        const inFolder = yield* threads.create({ location: 'folder', cwd: '/work/app' });
        assert.equal(inFolder.cwd, '/work/app');
        const failure = yield* threads.create({ agentId: 'broken', location: 'home', cwd: '/' }).pipe(Effect.flip);
        assert.equal(failure._tag, 'AgentUnavailable');
        assert.equal(failure.message, 'Broken is not installed.');
        assert.deepEqual((yield* threads.list()).map((thread) => thread.id).sort(), [inHome.id, inFolder.id].sort());
      }), { home });
  });

  it('streams a scripted turn, numbering events and grouping chunks into messages', async () => {
    const fake = new FakeAgents({
      script: () => [
        { type: 'chunk', kind: 'thought', text: 'Hmm. ' },
        { type: 'chunk', kind: 'thought', text: 'Right.' },
        { type: 'chunk', kind: 'text', text: 'The build ' },
        { type: 'chunk', kind: 'text', text: 'failed.' },
        { type: 'tool', tool: { id: 'tool-1', title: 'Read log', kind: 'read', status: 'completed', locations: [], content: [] } },
        { type: 'chunk', kind: 'text', text: 'Fixed.' },
        { type: 'end', stopReason: 'end_turn', error: null },
      ],
    });
    await withThreads((threads) =>
      Effect.gen(function* () {
        const thread = yield* createAttached(threads);
        const events = Array.from(yield* Stream.runCollect(threads.prompt(promptInput(thread.id, 'why did the build fail?'))));
        assert.deepEqual(shape(events), [
          'turn.started',
          'mode.changed',
          'chunk:thought:Hmm. ',
          'chunk:thought:Right.',
          'chunk:text:The build ',
          'chunk:text:failed.',
          'tool.updated',
          'chunk:text:Fixed.',
          'ended:end_turn',
        ]);
        assert.deepEqual(events.map((event) => event.seq), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
        const ids = events.flatMap((event) => (event.type === 'message.chunk' ? [event.messageId] : []));
        assert.equal(ids[0], ids[1]);
        assert.notEqual(ids[1], ids[2], 'a change of kind starts a new message');
        assert.equal(ids[2], ids[3]);
        assert.notEqual(ids[3], ids[4], 'a tool call in between starts a new message');

        // The agent got the context and the request, and access to the shell's folder.
        assert.match(fake.lastTurn?.text ?? '', /<shelly_context>[\s\S]*Working directory: \/work\/app[\s\S]*<\/shelly_context>\n\nwhy did the build fail\?$/);
        assert.deepEqual(fake.lastTurn?.request.additionalDirectories, ['/work/app']);

        const [after] = yield* threads.list();
        assert.equal(after?.title, 'why did the build fail?');
        assert.equal(after?.turnCount, 1);
        assert.equal(after?.status, 'idle');

        // History is compacted: one event per message.
        const { history } = yield* threads.attach({ threadId: thread.id, clientId: CLIENT, force: false, historyTurns: 1 });
        assert.deepEqual(shape(history), [
          'turn.started',
          'mode.changed',
          'chunk:thought:Hmm. Right.',
          'chunk:text:The build failed.',
          'tool.updated',
          'chunk:text:Fixed.',
          'ended:end_turn',
        ]);

        // The second turn resumes the agent's session.
        yield* Stream.runDrain(threads.prompt(promptInput(thread.id, 'and now?')));
        assert.equal(fake.sessionRequests.at(-1)?.nativeSessionId, 'native-1');
      }), { fake });
  });

  it('gives folder threads no extra directories', async () => {
    const fake = new FakeAgents({ script: () => [{ type: 'end', stopReason: 'end_turn', error: null }] });
    await withThreads((threads) =>
      Effect.gen(function* () {
        const thread = yield* createAttached(threads, 'folder');
        yield* Stream.runDrain(threads.prompt(promptInput(thread.id, 'hi')));
        assert.deepEqual(fake.lastTurn?.request.additionalDirectories, []);
        assert.equal(fake.lastTurn?.request.cwd, '/work/app');
      }), { fake });
  });

  it('waits on permission requests and resolves them when the driver answers', async () => {
    const fake = new FakeAgents();
    await withThreads((threads) =>
      Effect.gen(function* () {
        const thread = yield* createAttached(threads);
        const collecting = yield* Stream.runCollect(threads.prompt(promptInput(thread.id, 'delete it'))).pipe(Effect.forkChild);
        yield* eventually(() => fake.turns.length === 1);
        fake.lastTurn!.push({
          type: 'permission',
          requestId: 'r1',
          toolCallId: null,
          title: 'Delete a file',
          options: [{ optionId: 'yes', name: 'Yes', kind: 'allow_once' }],
        });
        let status = '';
        for (let attempt = 0; attempt < 100 && status !== 'waiting'; attempt++) {
          status = (yield* threads.list())[0]?.status ?? '';
          yield* Effect.sleep('5 millis');
        }
        assert.equal(status, 'waiting');

        const busy = yield* threads.respond({ threadId: thread.id, clientId: 'intruder', requestId: 'r1', optionId: 'yes' }).pipe(Effect.flip);
        assert.equal(busy._tag, 'ThreadBusy');
        const unknown = yield* threads.respond({ threadId: thread.id, clientId: CLIENT, requestId: 'nope', optionId: 'yes' }).pipe(Effect.flip);
        assert.equal(unknown._tag, 'UnknownRequest');

        yield* threads.respond({ threadId: thread.id, clientId: CLIENT, requestId: 'r1', optionId: 'yes' });
        assert.deepEqual(fake.responses, [{ requestId: 'r1', optionId: 'yes' }]);
        assert.equal((yield* threads.list())[0]?.status, 'running');
        // The agent's own report of the same resolution is not repeated.
        fake.lastTurn!.push({ type: 'permission.resolved', requestId: 'r1', optionId: 'yes' }, { type: 'end', stopReason: 'end_turn', error: null });
        const events = Array.from(yield* Fiber.join(collecting));
        assert.deepEqual(shape(events), ['turn.started', 'mode.changed', 'permission.requested:r1', 'permission.resolved:r1', 'ended:end_turn']);
      }), { fake });
  });

  it('cancels a turn, withdrawing open permission requests', async () => {
    const fake = new FakeAgents({
      script: () => [{ type: 'permission', requestId: 'r1', toolCallId: null, title: 'Run', options: [] }],
    });
    await withThreads((threads) =>
      Effect.gen(function* () {
        const thread = yield* createAttached(threads);
        const collecting = yield* Stream.runCollect(threads.prompt(promptInput(thread.id, 'go'))).pipe(Effect.forkChild);
        yield* eventually(() => fake.turns.length === 1);
        const busy = yield* threads.cancel(thread.id, 'intruder').pipe(Effect.flip);
        assert.equal(busy._tag, 'ThreadBusy');
        yield* threads.cancel(thread.id, CLIENT);
        const events = Array.from(yield* Fiber.join(collecting));
        assert.deepEqual(shape(events).slice(-2), ['permission.resolved:r1', 'ended:cancelled']);
        assert.equal(fake.cancels, 1);
        assert.equal(yield* threads.runningTurns, 0);
      }), { fake });
  });

  it('keeps a turn running when its prompt stream goes away, and lets a watcher catch up', async () => {
    const fake = new FakeAgents();
    await withThreads((threads) =>
      Effect.gen(function* () {
        const thread = yield* createAttached(threads);
        // Take the first two events, then stop listening.
        const firstTwo = Array.from(yield* Stream.runCollect(threads.prompt(promptInput(thread.id, 'long job')).pipe(Stream.take(2))));
        assert.deepEqual(shape(firstTwo), ['turn.started', 'mode.changed']);
        yield* eventually(() => fake.turns.length === 1);
        fake.lastTurn!.push({ type: 'chunk', kind: 'text', text: 'one ' });
        assert.equal(yield* threads.runningTurns, 1, 'the turn outlives its stream');

        const inProgress = yield* threads.prompt(promptInput(thread.id, 'again')).pipe(Stream.runDrain, Effect.flip);
        assert.equal(inProgress._tag, 'TurnInProgress');

        // A watcher from seq 2 replays the chunk, then follows live to the end.
        yield* Effect.sleep('10 millis');
        const watching = yield* Stream.runCollect(threads.watch(thread.id, 2)).pipe(Effect.forkChild);
        yield* Effect.sleep('10 millis');
        fake.lastTurn!.push({ type: 'chunk', kind: 'text', text: 'two' }, { type: 'end', stopReason: 'end_turn', error: null });
        const watched = Array.from(yield* Fiber.join(watching));
        assert.deepEqual(shape(watched), ['chunk:text:one ', 'chunk:text:two', 'ended:end_turn']);
        assert.deepEqual(watched.map((event) => event.seq), [3, 4, 5]);

        // Watching an idle thread replays and ends at once.
        const replay = Array.from(yield* Stream.runCollect(threads.watch(thread.id, 0)));
        assert.deepEqual(shape(replay), ['turn.started', 'mode.changed', 'chunk:text:one two', 'ended:end_turn']);
        const missing = yield* Stream.runDrain(threads.watch('nope', 0)).pipe(Effect.flip);
        assert.equal(missing._tag, 'ThreadNotFound');
      }), { fake });
  });

  it('lets one client drive a thread at a time', async () => {
    const fake = new FakeAgents({ script: () => [{ type: 'end', stopReason: 'end_turn', error: null }] });
    await withThreads((threads) =>
      Effect.gen(function* () {
        const thread = yield* createAttached(threads);
        const busy = yield* threads.attach({ threadId: thread.id, clientId: 'client-b', force: false, historyTurns: 0 }).pipe(Effect.flip);
        assert.equal(busy._tag, 'ThreadBusy');
        assert.equal(busy._tag === 'ThreadBusy' ? busy.attachedBy : null, CLIENT);

        const notDriver = yield* threads.prompt(promptInput(thread.id, 'hi', 'client-b')).pipe(Stream.runDrain, Effect.flip);
        assert.equal(notDriver._tag, 'ThreadBusy');
        const renameBusy = yield* threads.rename(thread.id, 'client-b', 'Mine').pipe(Effect.flip);
        assert.equal(renameBusy._tag, 'ThreadBusy');

        const taken = yield* threads.attach({ threadId: thread.id, clientId: 'client-b', force: true, historyTurns: 0 });
        assert.equal(taken.thread.attachedBy, 'client-b');
        yield* Stream.runDrain(threads.prompt(promptInput(thread.id, 'hi', 'client-b')));

        // A client that goes away lets go of its threads.
        yield* threads.releaseClient('client-b');
        assert.equal((yield* threads.list())[0]?.attachedBy, null);
        // Nobody has it: rename works from anyone; driving still needs attaching.
        yield* threads.rename(thread.id, 'client-c', '  Renamed  ');
        assert.equal((yield* threads.list())[0]?.title, 'Renamed');
        const unattached = yield* threads.cancel(thread.id, 'client-c').pipe(Effect.flip);
        assert.equal(unattached._tag, 'ThreadBusy');

        yield* threads.attach({ threadId: thread.id, clientId: 'client-c', force: false, historyTurns: 0 });
        yield* threads.detach(thread.id, 'client-c');
        assert.equal((yield* threads.list())[0]?.attachedBy, null);
      }), { fake });
  });

  it('reports session failures as typed errors and starts no turn', async () => {
    const fake = new FakeAgents();
    await withThreads((threads) =>
      Effect.gen(function* () {
        const thread = yield* createAttached(threads);
        fake.sessionError = new AgentUnavailable({ agentId: 'fake', reason: 'Sign in first.' });
        const failure = yield* threads.prompt(promptInput(thread.id, 'hi')).pipe(Stream.runDrain, Effect.flip);
        assert.equal(failure._tag, 'AgentUnavailable');
        const [row] = yield* threads.list();
        assert.equal(row?.turnCount, 0);
        assert.equal(row?.status, 'idle');
        fake.sessionError = undefined;
        fake.script = () => [{ type: 'end', stopReason: 'end_turn', error: null }];
        yield* Stream.runDrain(threads.prompt(promptInput(thread.id, 'hi')));
      }), { fake });
  });

  it('switches modes, renames and deletes', async () => {
    const fake = new FakeAgents();
    await withThreads((threads) =>
      Effect.gen(function* () {
        const thread = yield* createAttached(threads);
        yield* threads.setMode(thread.id, CLIENT, 'plan');
        assert.deepEqual(fake.modes, ['plan']);
        const busy = yield* threads.setMode(thread.id, 'other', 'plan').pipe(Effect.flip);
        assert.equal(busy._tag, 'ThreadBusy');
        const events = Array.from(yield* Stream.runCollect(threads.watch(thread.id, 0)));
        assert.deepEqual(shape(events), ['mode.changed']);

        yield* threads.rename(thread.id, CLIENT, 'A name');
        assert.equal((yield* threads.list())[0]?.title, 'A name');

        yield* threads.remove(thread.id, CLIENT);
        assert.deepEqual(fake.released, [thread.id]);
        assert.deepEqual(yield* threads.list(), []);
        const gone = yield* threads.remove(thread.id, CLIENT).pipe(Effect.flip);
        assert.equal(gone._tag, 'ThreadNotFound');
      }), { fake });
  });

  it('prewarms in the background', async () => {
    const fake = new FakeAgents();
    await withThreads((threads) =>
      Effect.gen(function* () {
        const thread = yield* createAttached(threads);
        yield* threads.prewarm({ threadId: thread.id });
        yield* threads.prewarm({});
        yield* eventually(() => fake.prewarmed.length === 2);
        assert.deepEqual(fake.prewarmed.toSorted((a, b) => String(a.threadId).localeCompare(String(b.threadId))), [
          { agentId: 'fake', threadId: thread.id },
          { agentId: 'fake', threadId: null },
        ].toSorted((a, b) => String(a.threadId).localeCompare(String(b.threadId))));
      }), { fake });
  });

  it('ends running turns as interrupted when the daemon stops, and reconciles on the next start', async () => {
    const home = newHome();
    const fake = new FakeAgents();
    let threadId = '';
    await withThreads((threads) =>
      Effect.gen(function* () {
        const thread = yield* createAttached(threads);
        threadId = thread.id;
        yield* threads.prompt(promptInput(thread.id, 'long job')).pipe(Stream.take(1), Stream.runDrain);
        yield* eventually(() => fake.turns.length === 1);
      }), { fake, home });
    // Closing the service interrupted the turn.
    assert.equal(fake.cancels, 1);
    await withThreads((threads) =>
      Effect.gen(function* () {
        const events = Array.from(yield* Stream.runCollect(threads.watch(threadId, 0)));
        assert.deepEqual(shape(events).at(-1), 'ended:interrupted');
        assert.equal((yield* threads.list())[0]?.status, 'idle');
      }), { home });
  });
});

describe('ThreadService while a turn is starting', () => {
  it('ends the turn and frees the thread when setup fails after the turn started', async () => {
    const fake = new FakeAgents({ script: () => [{ type: 'end', stopReason: 'end_turn', error: null }] });
    let armed = true;
    // The store fails once, on the event right after turn.started.
    const wrapStore: StoreWrapper = (store) => ({
      ...store,
      appendEvents: (threadId, events) =>
        armed && events[0]?.type === 'mode.changed'
          ? Effect.sync(() => {
            armed = false;
          }).pipe(Effect.andThen(Effect.die(new Error('disk full'))))
          : store.appendEvents(threadId, events),
    });
    await withThreads((threads) =>
      Effect.gen(function* () {
        const thread = yield* createAttached(threads);
        const exit = yield* Stream.runDrain(threads.prompt(promptInput(thread.id, 'hi'))).pipe(Effect.exit);
        assert.equal(exit._tag, 'Failure', 'the prompt reports the failure');

        const [row] = yield* threads.list();
        assert.equal(row?.status, 'idle');
        assert.equal(yield* threads.runningTurns, 0);
        assert.deepEqual(shape(Array.from(yield* Stream.runCollect(threads.watch(thread.id, 0)))), ['turn.started', 'ended:error']);
        assert.ok(fake.released.includes(thread.id), 'the session is released');
        assert.equal(fake.turns.length, 0, 'the agent never got the prompt');

        // The thread works again.
        const events = Array.from(yield* Stream.runCollect(threads.prompt(promptInput(thread.id, 'again'))));
        assert.equal(shape(events).at(-1), 'ended:end_turn');
      }), { fake, wrapStore });
  });

  it('lets a thread be deleted while its prompt waits for the agent, and writes nothing after', async () => {
    const home = newHome();
    const fake = new FakeAgents({ script: () => [{ type: 'end', stopReason: 'end_turn', error: null }] });
    let threadId = '';
    await withThreads((threads) =>
      Effect.gen(function* () {
        const thread = yield* createAttached(threads);
        threadId = thread.id;
        const open = gateSessions(fake);
        const prompting = yield* Stream.runDrain(threads.prompt(promptInput(thread.id, 'hi'))).pipe(Effect.flip, Effect.forkChild);
        yield* eventually(() => fake.sessionRequests.length === 1);

        yield* threads.remove(thread.id, CLIENT);
        open();
        const failure = yield* Fiber.join(prompting);
        assert.equal(failure._tag, 'ThreadNotFound');
        assert.deepEqual(yield* threads.list(), []);
        assert.equal(fake.turns.length, 0, 'the agent never got the prompt');
        assert.equal(fake.released.filter((id) => id === thread.id).length, 2, 'the new session is released too');
      }), { fake, home });
    assert.equal(storedEventCount(home, threadId), 0);
  });

  it('keeps a rename made while the prompt waits for the agent', async () => {
    const fake = new FakeAgents({ script: () => [{ type: 'end', stopReason: 'end_turn', error: null }] });
    await withThreads((threads) =>
      Effect.gen(function* () {
        const thread = yield* createAttached(threads);
        const open = gateSessions(fake);
        const prompting = yield* Stream.runDrain(threads.prompt(promptInput(thread.id, 'the first prompt'))).pipe(Effect.forkChild);
        yield* eventually(() => fake.sessionRequests.length === 1);
        yield* threads.rename(thread.id, CLIENT, 'Chosen name');
        open();
        yield* Fiber.join(prompting);
        assert.equal((yield* threads.list())[0]?.title, 'Chosen name');
      }), { fake });
  });

  it('cancels a turn whose prompt is still waiting for the agent', async () => {
    const fake = new FakeAgents({ script: () => [{ type: 'end', stopReason: 'end_turn', error: null }] });
    await withThreads((threads) =>
      Effect.gen(function* () {
        const thread = yield* createAttached(threads);
        const open = gateSessions(fake);
        const prompting = yield* Stream.runCollect(threads.prompt(promptInput(thread.id, 'hi'))).pipe(Effect.forkChild);
        yield* eventually(() => fake.sessionRequests.length === 1);
        yield* threads.cancel(thread.id, CLIENT);
        open();
        const events = Array.from(yield* Fiber.join(prompting));
        assert.equal(shape(events).at(-1), 'ended:cancelled');
        assert.equal(fake.turns.length, 0, 'the agent never got the prompt');
        assert.equal((yield* threads.list())[0]?.status, 'idle');
      }), { fake });
  });

  it('keeps a turn running when its driver detaches, for the next driver to answer', async () => {
    const fake = new FakeAgents({ script: () => [{ type: 'permission', requestId: 'r1', toolCallId: null, title: 'Run', options: [] }] });
    await withThreads((threads) =>
      Effect.gen(function* () {
        const thread = yield* createAttached(threads);
        yield* threads.prompt(promptInput(thread.id, 'go')).pipe(Stream.takeUntil((event) => event.type === 'permission.requested'), Stream.runDrain);
        yield* threads.detach(thread.id, CLIENT);
        assert.equal(yield* threads.runningTurns, 1);
        yield* threads.attach({ threadId: thread.id, clientId: 'client-b', force: false, historyTurns: 0 });
        const busy = yield* threads.respond({ threadId: thread.id, clientId: CLIENT, requestId: 'r1', optionId: 'yes' }).pipe(Effect.flip);
        assert.equal(busy._tag, 'ThreadBusy', 'the old driver no longer answers');
        // The scripted agent finishes once answered.
        yield* threads.respond({ threadId: thread.id, clientId: 'client-b', requestId: 'r1', optionId: 'yes' });
        yield* eventually(() => fake.responses.length === 1);
        const events = Array.from(yield* Stream.runCollect(threads.watch(thread.id, 0)));
        assert.equal(shape(events).at(-1), 'ended:end_turn');
      }), { fake });
  });
});

/** What a client shows for one message: chunks append, unless one says it is the whole text so far. */
const showMessage = (seen: string, events: readonly ThreadEvent[]): string =>
  events.reduce((text, event) => (event.type !== 'message.chunk' ? text : event.replace ? event.text : text + event.text), seen);

describe('ThreadService under races and shutdown', () => {
  it('ends every stuck turn at once when the daemon stops, not one after another', async () => {
    const fake = new FakeAgents({ ignoresCancel: () => true });
    let stoppingAt = 0;
    await withThreads((threads) =>
      Effect.gen(function* () {
        for (let index = 0; index < 3; index++) {
          const thread = yield* createAttached(threads);
          yield* threads.prompt(promptInput(thread.id, 'stuck')).pipe(Stream.take(1), Stream.runDrain);
        }
        yield* eventually(() => fake.turns.length === 3);
        stoppingAt = Date.now();
      }), { fake });
    const took = Date.now() - stoppingAt;
    assert.equal(fake.cancels, 3);
    // Each stuck cancel is given 2 s: one after another would take 6 s.
    assert.ok(took < 4000, `stopping took ${took}ms`);
  });

  it('marks a compacted message as the whole text, so a watcher resuming inside it does not repeat it', async () => {
    const fake = new FakeAgents();
    await withThreads((threads) =>
      Effect.gen(function* () {
        const thread = yield* createAttached(threads);
        const collecting = yield* Stream.runCollect(threads.prompt(promptInput(thread.id, 'greet'))).pipe(Effect.forkChild);
        yield* eventually(() => fake.turns.length === 1);
        fake.lastTurn!.push(
          { type: 'chunk', kind: 'text', text: 'Hel' },
          { type: 'chunk', kind: 'text', text: 'lo' },
          { type: 'end', stopReason: 'end_turn', error: null },
        );
        const live = Array.from(yield* Fiber.join(collecting));
        const first = live.find((event) => event.type === 'message.chunk')!;
        // A client saw "Hel", lost the connection, and catches up after the turn was compacted.
        const seen = showMessage('', [first]);
        const caughtUp = Array.from(yield* Stream.runCollect(threads.watch(thread.id, first.seq)));
        assert.deepEqual(shape(caughtUp), ['chunk:text:Hello', 'ended:end_turn']);
        assert.equal(showMessage(seen, caughtUp), 'Hello');
        // Live chunks are increments.
        assert.ok(live.every((event) => event.type !== 'message.chunk' || event.replace === undefined));
      }), { fake });
  });

  it('starts a new message after a mode change, so compaction keeps them apart', async () => {
    const fake = new FakeAgents();
    await withThreads((threads) =>
      Effect.gen(function* () {
        const thread = yield* createAttached(threads);
        const collecting = yield* Stream.runCollect(threads.prompt(promptInput(thread.id, 'plan it'))).pipe(Effect.forkChild);
        yield* eventually(() => fake.turns.length === 1);
        fake.lastTurn!.push({ type: 'chunk', kind: 'text', text: 'before' });
        yield* Effect.sleep('20 millis');
        yield* threads.setMode(thread.id, CLIENT, 'plan');
        fake.lastTurn!.push({ type: 'chunk', kind: 'text', text: 'after' }, { type: 'end', stopReason: 'end_turn', error: null });
        const live = Array.from(yield* Fiber.join(collecting));
        const ids = live.flatMap((event) => (event.type === 'message.chunk' ? [event.messageId] : []));
        assert.notEqual(ids[0], ids[1]);
        const { history } = yield* threads.attach({ threadId: thread.id, clientId: CLIENT, force: false, historyTurns: 1 });
        assert.deepEqual(shape(history), ['turn.started', 'mode.changed', 'chunk:text:before', 'mode.changed', 'chunk:text:after', 'ended:end_turn']);
      }), { fake });
  });

  it('fails setMode with ThreadNotFound when the thread is deleted while the agent starts, and releases the session', async () => {
    const home = newHome();
    const fake = new FakeAgents();
    let threadId = '';
    await withThreads((threads) =>
      Effect.gen(function* () {
        const thread = yield* createAttached(threads);
        threadId = thread.id;
        const open = gateSessions(fake);
        const setting = yield* threads.setMode(thread.id, CLIENT, 'plan').pipe(Effect.flip, Effect.forkChild);
        yield* eventually(() => fake.sessionRequests.length === 1);
        yield* threads.remove(thread.id, CLIENT);
        open();
        const failure = yield* Fiber.join(setting);
        assert.equal(failure._tag, 'ThreadNotFound');
        assert.deepEqual(fake.modes, [], 'the agent was not switched');
        assert.equal(fake.released.filter((id) => id === thread.id).length, 2, 'the new session is released too');
      }), { fake, home });
    assert.equal(storedEventCount(home, threadId), 0);
  });

  it('releases a session prewarmed for a thread deleted meanwhile', async () => {
    const fake = new FakeAgents();
    await withThreads((threads) =>
      Effect.gen(function* () {
        const thread = yield* createAttached(threads);
        const open = gateSessions(fake);
        yield* threads.prewarm({ threadId: thread.id });
        yield* Effect.sleep('20 millis');
        yield* threads.remove(thread.id, CLIENT);
        assert.equal(fake.released.filter((id) => id === thread.id).length, 1);
        open();
        yield* eventually(() => fake.released.filter((id) => id === thread.id).length === 2);
        assert.deepEqual(yield* threads.list(), []);
      }), { fake });
  });

  it('keeps nothing in memory for a prompt to a thread that does not exist', async () => {
    const looked: string[] = [];
    const wrapStore: StoreWrapper = (store) => ({
      ...store,
      lastSeq: (threadId) => Effect.sync(() => looked.push(threadId)).pipe(Effect.andThen(store.lastSeq(threadId))),
    });
    await withThreads((threads) =>
      Effect.gen(function* () {
        const failure = yield* threads.prompt(promptInput('nope', 'hi')).pipe(Stream.runDrain, Effect.flip);
        assert.equal(failure._tag, 'ThreadNotFound');
        assert.deepEqual(looked, [], 'no live state was set up for it');
      }), { wrapStore });
  });

  it('gives up waiting on an agent that ignores cancel, and frees the thread', async () => {
    const fake = new FakeAgents({ ignoresCancel: () => true });
    await withThreads((threads) =>
      Effect.gen(function* () {
        const thread = yield* createAttached(threads);
        yield* threads.prompt(promptInput(thread.id, 'stuck')).pipe(Stream.take(1), Stream.runDrain);
        yield* eventually(() => fake.turns.length === 1);
        const startedAt = Date.now();
        const exit = yield* threads.cancel(thread.id, CLIENT).pipe(Effect.timeout('5 seconds'), Effect.exit);
        assert.equal(exit._tag, 'Success', 'cancel returns');
        assert.ok(Date.now() - startedAt < 4000);
        // The thread's lock is free again.
        yield* threads.rename(thread.id, CLIENT, 'Still here').pipe(Effect.timeout('1 second'));
      }), { fake });
  });
});
