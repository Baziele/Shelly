import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { FastEvent, ThreadEvent, ThreadSummary } from '../protocol/schema.js';
import { LINE_KEYS } from '../shell/line-editor.js';
import { deferred, type Rig, sleep, startRig, summary, typeKeys, until } from '../../test/support/shelly-rig.js';

/*
 * The real Shelly against a slow or failing daemon, with keys typed at the
 * worst moments. Two promises hold throughout: nothing the user did not
 * mean to run reaches the shell as a command, and the prompt always comes
 * back.
 */

// A lockout shows within a second, not after the default five.
process.env.SHELLY_BUSY_WATCHDOG_MS = '300';

const tagged = (tag: string, message = tag) => Object.assign(new Error(message), { _tag: tag });
const event = (fields: Record<string, unknown>) => fields as unknown as ThreadEvent;
const plain = (text: string) => text.replace(/\u001b\[[0-9;?]*[A-Za-z]|\u001b\][^\u0007]*\u0007/g, '');

const openAgent = async (rig: Rig) => {
  await typeKeys(rig, '::');
  await until(() => rig.mode() === 'overlay', 'the input to open');
};

/** Back at the shell, nothing run, and the half-typed line still there, unexecuted. */
const assertNothingRan = (rig: Rig, line: string) => {
  assert.deepEqual(rig.executed, [], `nothing the user typed was run; the shell got ${JSON.stringify(rig.toShell.slice(-6))}`);
  assert.equal(rig.shellLine(), line);
};

describe('a slash command that finishes after the user went back to the shell', () => {
  it('/threads: Esc while the thread attaches, a command half-typed, then the attach: nothing runs, nothing is drawn', async () => {
    const rig = await startRig();
    try {
      const attach = deferred<{ thread: ThreadSummary; history: [] }>();
      rig.daemon.override.attachThread = () => attach.promise;
      await openAgent(rig);
      await typeKeys(rig, '/threads');
      rig.type('\r');
      await until(() => rig.daemon.calls.includes('listThreads'), 'the thread list');
      await sleep(50);
      rig.type('\r'); // the first thread: the switch waits for the attach
      await until(() => rig.daemon.calls.includes('attachThread'), 'the attach');
      for (let i = 0; i < 3 && rig.mode() !== 'shell'; i++) {
        rig.type('\u001b');
        await sleep(120);
      }
      assert.equal(rig.mode(), 'shell');
      await typeKeys(rig, 'rm -rf build');

      const before = rig.written().length;
      attach.resolve({ thread: summary('old'), history: [] });
      await sleep(50);
      assert.equal(rig.mode(), 'shell', 'the late switch took nothing');
      rig.prompt();
      await sleep(50);
      assertNothingRan(rig, 'rm -rf build');
      assert.doesNotMatch(plain(rig.written().slice(before)), /threads|thread old/, 'nothing drawn for the abandoned switch');
      assert.ok(rig.daemon.calls.includes('detachThread'), 'the thread attached for nothing is let go');
    } finally {
      await rig.stop();
    }
  });

  it('"Take it over": Esc while the take-over attaches, then the attach: nothing runs', async () => {
    const rig = await startRig();
    try {
      const takeOver = deferred<{ thread: ThreadSummary; history: [] }>();
      rig.daemon.override.attachThread = (_id: never, options: never) =>
        (options as { force?: boolean }).force ? takeOver.promise : Promise.reject(tagged('ThreadBusy'));
      await openAgent(rig);
      await typeKeys(rig, '/threads');
      rig.type('\r');
      await until(() => rig.daemon.calls.includes('listThreads'), 'the thread list');
      await sleep(50);
      rig.type('\r');
      await until(() => /Take it over/.test(plain(rig.written())), 'the take-over question');
      await sleep(50);
      rig.type('\r'); // Take it over
      await until(() => rig.daemon.calls.filter((call) => call === 'attachThread').length === 2, 'the forced attach');
      for (let i = 0; i < 3 && rig.mode() !== 'shell'; i++) {
        rig.type('\u001b');
        await sleep(120);
      }
      assert.equal(rig.mode(), 'shell');
      await typeKeys(rig, 'git reset --hard');
      takeOver.resolve({ thread: summary('old'), history: [] });
      await sleep(50);
      assert.equal(rig.mode(), 'shell');
      rig.prompt();
      await sleep(50);
      assertNothingRan(rig, 'git reset --hard');
    } finally {
      await rig.stop();
    }
  });

  it('watching a thread that runs elsewhere: Esc while it attaches, then the attach: nothing runs', async () => {
    const rig = await startRig();
    try {
      // Switch to a thread another terminal is running (no turn in its history yet): it becomes current.
      rig.daemon.override.listThreads = () => Promise.resolve([summary('busy', { status: 'running' })]);
      rig.daemon.override.attachThread = (id: never) => Promise.resolve({ thread: summary(id, { status: 'running' }), history: [] });
      await openAgent(rig);
      await typeKeys(rig, '/threads');
      rig.type('\r');
      await until(() => rig.daemon.calls.includes('listThreads'), 'the thread list');
      await sleep(50);
      rig.type('\r');
      await until(() => rig.mode() === 'returning', 'the switch');
      rig.prompt();
      await until(() => rig.mode() === 'shell', 'the shell');

      // Enter on an empty :: watches it; the daemon is slow to attach.
      const attach = deferred<{ thread: ThreadSummary; history: ThreadEvent[] }>();
      rig.daemon.override.attachThread = () => attach.promise;
      await openAgent(rig);
      rig.type('\r');
      await sleep(50);
      for (let i = 0; i < 3 && rig.mode() !== 'shell'; i++) {
        rig.type('\u001b');
        await sleep(120);
      }
      assert.equal(rig.mode(), 'shell');
      await typeKeys(rig, 'make deploy');
      attach.resolve({
        thread: summary('busy', { status: 'running' }),
        history: [event({ seq: 7, type: 'turn.started', turnId: 'u9', text: 'elsewhere', at: 0 })],
      });
      await sleep(50);
      assert.equal(rig.mode(), 'shell');
      assert.equal(rig.daemon.watches.length, 0, 'no watch for an input that closed');
      rig.prompt();
      await sleep(50);
      assertNothingRan(rig, 'make deploy');
    } finally {
      for (const watch of rig.daemon.watches) watch.feed.end();
      await rig.stop();
    }
  });
});

describe('keys before the turn is under way', () => {
  const begin = async (options: Parameters<typeof startRig>[0] = {}) => {
    const rig = await startRig(options);
    const create = deferred<ThreadSummary>();
    rig.daemon.override.createThread = () => create.promise;
    await openAgent(rig);
    await typeKeys(rig, 'refactor everything');
    rig.type('\r');
    await until(() => rig.daemon.calls.includes('createThread'), 'the thread being made');
    return { rig, create };
  };

  it('Esc while the thread is being made: the prompt comes back at once, and the turn goes ahead out of sight', async () => {
    const { rig, create } = await begin();
    try {
      await sleep(50); // the view is up
      rig.type('\u001b');
      await until(() => rig.mode() === 'returning', 'the hand-back', 250);
      rig.prompt();
      await until(() => rig.mode() === 'shell', 'the shell');
      create.resolve(summary('t1'));
      await until(() => rig.daemon.prompts.length === 1, 'the prompt sent in the background');
      const before = rig.written().length;
      const { feed } = rig.daemon.prompts[0]!;
      feed.push(event({ seq: 1, type: 'turn.started', turnId: 'u1', text: 'refactor everything', at: Date.now() }));
      feed.push(event({ seq: 2, type: 'message.chunk', turnId: 'u1', messageId: 'm', kind: 'text', text: 'UNSEEN' }));
      await sleep(50);
      assert.equal(rig.mode(), 'shell', 'the turn does not take the terminal back');
      assert.doesNotMatch(rig.written().slice(before), /UNSEEN/);
      feed.end();
    } finally {
      create.resolve(summary('t1'));
      await rig.stop();
    }
  });

  it('Esc while the thread is being made, then another request: refused until the first is under way, no second thread', async () => {
    const { rig, create } = await begin();
    try {
      await sleep(50);
      rig.type('\u001b');
      await until(() => rig.mode() === 'returning', 'the hand-back', 250);
      rig.prompt();
      await until(() => rig.mode() === 'shell', 'the shell');
      await openAgent(rig);
      await typeKeys(rig, 'and another');
      rig.type('\r');
      await until(() => /Still sending your last request/.test(plain(rig.written())), 'the refusal');
      assert.equal(rig.mode(), 'overlay', 'the input stays open, with what was typed');
      assert.equal(rig.daemon.calls.filter((call) => call === 'createThread').length, 1);
    } finally {
      create.resolve(summary('t1'));
      await sleep(20);
      for (const prompt of rig.daemon.prompts) prompt.feed.end();
      await rig.stop();
    }
  });

  it('Ctrl-C while the thread is being made: the request is never sent, and the prompt comes back', async () => {
    const { rig, create } = await begin();
    try {
      await sleep(50);
      rig.type('\u0003');
      await sleep(50);
      create.resolve(summary('t1'));
      await until(() => rig.mode() === 'returning', 'the hand-back');
      await sleep(50);
      assert.equal(rig.daemon.prompts.length, 0, `a request the user stopped was sent; calls: ${rig.daemon.calls.join(',')}`);
      rig.prompt();
      await until(() => rig.mode() === 'shell', 'the shell');
      assert.deepEqual(rig.toShell.filter((data) => data.includes('\u0003')), [], 'the Ctrl-C was the turn\'s, not the shell\'s');
    } finally {
      await rig.stop();
    }
  });

  it('Ctrl-C before the terminal even said where the cursor is: acted on, not dropped', async () => {
    const { rig, create } = await begin({ cursorQuery: () => sleep(150).then(() => ({ row: 5, col: 3 })) });
    try {
      rig.type('\u0003'); // the view has not started: the cursor report is still on its way
      await sleep(200);
      create.resolve(summary('t1'));
      await until(() => rig.mode() === 'returning', 'the hand-back');
      assert.equal(rig.daemon.prompts.length, 0, 'never sent');
    } finally {
      await rig.stop();
    }
  });

  it('Ctrl-C after the request went but before the daemon took it: stopped as soon as it does', async () => {
    const rig = await startRig();
    try {
      await openAgent(rig);
      await typeKeys(rig, 'hi');
      rig.type('\r');
      await until(() => rig.daemon.prompts.length === 1, 'the prompt');
      await sleep(30);
      rig.type('\u0003');
      await sleep(20);
      const { feed } = rig.daemon.prompts[0]!;
      feed.push(event({ seq: 1, type: 'turn.started', turnId: 'u1', text: 'hi', at: Date.now() }));
      await until(() => rig.daemon.calls.includes('cancel'), 'the cancel');
      feed.push(event({ seq: 2, type: 'turn.ended', turnId: 'u1', stopReason: 'cancelled', error: null, durationMs: 1 }));
      await until(() => rig.mode() === 'returning', 'the hand-back', 4000);
    } finally {
      await rig.stop();
    }
  });
});

describe('the daemon failing under the flows', () => {
  it('opening :: when the agent list fails: the reason in the input, no unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    const listener = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', listener);
    const rig = await startRig();
    try {
      rig.daemon.override.listAgents = () => Promise.reject(tagged('DaemonDisconnected', 'gone'));
      await openAgent(rig);
      await sleep(50);
      assert.deepEqual(unhandled.map(String), []);
      assert.match(plain(rig.written()), /Lost the connection/);
    } finally {
      process.off('unhandledRejection', listener);
      await rig.stop();
    }
  });

  it('a prompt that fails before the terminal reports the cursor: the reason on screen, the prompt back', async () => {
    // A terminal over ssh: the cursor report takes a few tens of ms; the daemon answers in one.
    const rig = await startRig({ cursorQuery: () => sleep(40).then(() => ({ row: 5, col: 3 })) });
    try {
      rig.daemon.override.createThread = () => Promise.reject(new Error('No agent is set up: run shelly agents'));
      await openAgent(rig);
      await typeKeys(rig, 'hello');
      rig.type('\r');
      await until(() => rig.mode() === 'returning' || rig.mode() === 'shell', 'the prompt to come back', 3000);
      rig.prompt();
      await sleep(100);
      assert.match(rig.written(), /No agent is set up/);
      assert.equal(rig.mode(), 'shell');
    } finally {
      await rig.stop();
    }
  });

  const firstTurn = async (rig: Rig) => {
    await openAgent(rig);
    await typeKeys(rig, 'first');
    rig.type('\r');
    await until(() => rig.daemon.prompts.length === 1, 'the first prompt');
    const { feed } = rig.daemon.prompts[0]!;
    feed.push(event({ seq: 1, type: 'turn.started', turnId: 'u1', text: 'first', at: 0 }));
    feed.push(event({ seq: 2, type: 'message.chunk', turnId: 'u1', messageId: 'm1', kind: 'text', text: 'OLD ANSWER' }));
    feed.push(event({ seq: 3, type: 'turn.ended', turnId: 'u1', stopReason: 'end_turn', error: null, durationMs: 1 }));
    await until(() => rig.mode() === 'returning', 'the hand-back', 4000);
    rig.prompt();
    await until(() => rig.mode() === 'shell', 'the shell');
    await openAgent(rig);
    await typeKeys(rig, 'second');
    rig.type('\r');
    await until(() => rig.daemon.prompts.length === 2, 'the second prompt');
    return rig.daemon.prompts[1]!;
  };

  it('the daemon lost before it took the request, which never arrived: says so, never shows an old turn', async () => {
    const rig = await startRig();
    try {
      const second = await firstTurn(rig);
      const before = rig.written().length;
      // The new daemon's thread has only the old turn.
      rig.daemon.override.attachThread = (id: never) => Promise.resolve({
        thread: summary(id),
        history: [
          event({ seq: 1, type: 'turn.started', turnId: 'u1', text: 'first', at: 0 }),
          event({ seq: 3, type: 'turn.ended', turnId: 'u1', stopReason: 'end_turn', error: null, durationMs: 1 }),
        ],
      });
      second.feed.fail(tagged('DaemonDisconnected'));
      await until(() => rig.mode() === 'returning', 'the hand-back', 4000);
      assert.equal(rig.daemon.watches.length, 0, 'no replay of the thread');
      const shown = plain(rig.written().slice(before));
      assert.doesNotMatch(shown, /OLD ANSWER/);
      assert.match(shown, /may not have your request/);
    } finally {
      await rig.stop();
    }
  });

  it('the daemon lost before it took the request, which did arrive: followed from its own start', async () => {
    const rig = await startRig();
    try {
      const second = await firstTurn(rig);
      rig.daemon.override.attachThread = (id: never) => Promise.resolve({
        thread: summary(id),
        history: [event({ seq: 4, type: 'turn.started', turnId: 'u2', text: 'second', at: Date.now() })],
      });
      second.feed.fail(tagged('DaemonDisconnected'));
      await until(() => rig.daemon.watches.length === 1, 'the recovery watch');
      assert.equal(rig.daemon.watches[0]!.afterSeq, 3, 'from just before its turn.started');
      const watch = rig.daemon.watches[0]!.feed;
      watch.push(event({ seq: 4, type: 'turn.started', turnId: 'u2', text: 'second', at: Date.now() }));
      watch.push(event({ seq: 5, type: 'message.chunk', turnId: 'u2', messageId: 'm2', kind: 'text', text: 'NEW ANSWER' }));
      watch.push(event({ seq: 6, type: 'turn.ended', turnId: 'u2', stopReason: 'end_turn', error: null, durationMs: 1 }));
      await until(() => rig.mode() === 'returning', 'the hand-back', 4000);
      assert.match(plain(rig.written()), /NEW ANSWER/);
    } finally {
      await rig.stop();
    }
  });
});

describe('keys that reach the shell after Shelly had the terminal', () => {
  it('a multi-line paste during a turn arrives as one paste, newlines inside it', async () => {
    const rig = await startRig();
    try {
      await openAgent(rig);
      await typeKeys(rig, 'hi');
      rig.type('\r');
      await until(() => rig.daemon.prompts.length === 1, 'the prompt');
      const { feed } = rig.daemon.prompts[0]!;
      feed.push(event({ seq: 1, type: 'turn.started', turnId: 'u1', text: 'hi', at: 0 }));
      await sleep(30);
      rig.type('\u001b[200~cd /tmp\nls -la\u001b[201~');
      feed.push(event({ seq: 2, type: 'message.chunk', turnId: 'u1', messageId: 'm', kind: 'text', text: 'ok' }));
      feed.push(event({ seq: 3, type: 'turn.ended', turnId: 'u1', stopReason: 'end_turn', error: null, durationMs: 1 }));
      await until(() => rig.mode() === 'returning', 'the hand-back', 4000);
      rig.prompt();
      await until(() => rig.mode() === 'shell', 'the shell');
      await sleep(20);
      const sent = rig.toShell.slice(rig.toShell.lastIndexOf('\r') + 1).join('');
      assert.equal(sent, '\u001b[200~cd /tmp\nls -la\u001b[201~');
    } finally {
      await rig.stop();
    }
  });

  it('Ctrl+] with a shell slow to answer the capture: the instruction typed meanwhile is never run', async () => {
    const rig = await startRig();
    try {
      await typeKeys(rig, 'git push --force');
      rig.type('\u001d');
      await sleep(20);
      assert.equal(rig.mode(), 'capturing');
      await typeKeys(rig, ' make it safe\r', 10);
      await until(() => rig.mode() === 'shell', 'the capture to give up', 3000);
      await sleep(50);
      assertNothingRan(rig, 'git push --force make it safe');
    } finally {
      await rig.stop();
    }
  });

  it('a terminal that never answers the cursor query: what was typed after :: stays on the line, unrun', async () => {
    const rig = await startRig({ cursorQuery: () => sleep(500).then(() => Promise.reject(new Error('no answer'))) });
    try {
      await typeKeys(rig, '::');
      await typeKeys(rig, 'delete the logs\r', 10);
      await until(() => rig.mode() === 'shell', 'the fallback', 3000);
      await sleep(20);
      assertNothingRan(rig, '::delete the logs');
    } finally {
      await rig.stop();
    }
  });

  it('keys typed while the line is being set go after it, not under it', async () => {
    const rig = await startRig();
    try {
      await typeKeys(rig, '__');
      await until(() => rig.mode() === 'overlay', 'fast mode');
      await typeKeys(rig, 'list files');
      rig.type('\r');
      await until(() => rig.daemon.fast.length === 1, 'the request');
      rig.daemon.fast[0]!.feed.push({ type: 'done', text: 'ls -la', kind: 'command', durationMs: 1 } as FastEvent);
      rig.daemon.fast[0]!.feed.end();
      await until(() => rig.toShell.includes(LINE_KEYS.set), 'the line being set');
      rig.type('x');
      await sleep(30);
      assert.ok(!rig.toShell.includes('x'), 'held until the shell has set the line');
      rig.shellOutput(rig.marker('line-set', '1'));
      await until(() => rig.toShell.includes('x'), 'the key, after');
      assert.ok(rig.toShell.indexOf('x') > rig.toShell.indexOf(LINE_KEYS.set));
      assert.equal(rig.mode(), 'shell');
    } finally {
      await rig.stop();
    }
  });
});

describe('the terminal changing under Shelly', () => {
  it('a resize while the input opens: it is laid out again once open', async () => {
    const rig = await startRig({ cursorQuery: () => sleep(60).then(() => ({ row: 5, col: 3 })) });
    try {
      await typeKeys(rig, '::');
      assert.equal(rig.mode(), 'opening');
      rig.resize({ cols: 80, rows: 24 });
      await until(() => rig.mode() === 'overlay', 'the input');
      const queries = rig.cursorQueries();
      await until(() => rig.cursorQueries() > queries, 'a relayout (a fresh cursor query)', 1000);
    } finally {
      await rig.stop();
    }
  });

  it('the shell exiting mid-turn: nothing is drawn after Shelly let go of the terminal', async () => {
    const rig = await startRig();
    await openAgent(rig);
    await typeKeys(rig, 'hi');
    rig.type('\r');
    await until(() => rig.daemon.prompts.length === 1, 'the prompt');
    const { feed } = rig.daemon.prompts[0]!;
    feed.push(event({ seq: 1, type: 'turn.started', turnId: 'u1', text: 'hi', at: 0 }));
    await sleep(50);
    await rig.stop();
    const before = rig.written().length;
    feed.push(event({ seq: 2, type: 'message.chunk', turnId: 'u1', messageId: 'm', kind: 'text', text: 'STILL DRAWING' }));
    await sleep(300);
    feed.end();
    assert.equal(rig.written().slice(before), '');
  });
});
