import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AgentInfo, ModeState, ThreadSummary } from '../protocol/schema.js';
import type { PickerRequest } from '../ui/prompt-view.js';
import { AgentSession } from './agent-session.js';
import type { DaemonClient } from './daemon-client.js';
import type { FlowHost, OpenInput, ReleaseOptions } from './flow-host.js';

/* Agent mode's flows with a fake terminal and daemon: the terminal always comes back, and looking leaves nothing behind. */

const tick = () => new Promise((resolve) => setImmediate(resolve));

const MODES: ModeState = {
  currentModeId: 'default',
  availableModes: [
    { id: 'default', name: 'Default', description: null },
    { id: 'plan', name: 'Plan', description: null },
  ],
};

const AGENTS: AgentInfo[] = [{ id: 'fake', name: 'Fake', available: true, unavailableReason: null, supportsFast: false, isDefault: true }];

const summary = (id: string): ThreadSummary => ({
  id, title: '', agentId: 'fake', location: 'home', cwd: '/home', createdAt: 0, updatedAt: 0, status: 'idle', turnCount: 0, attachedBy: null,
});

class DaemonError extends Error {
  constructor(readonly _tag: string, fields: Record<string, unknown>, message: string) {
    super(message);
    Object.assign(this, fields);
  }
}

const setup = (overrides: Partial<FlowHost> = {}, daemon: { agents?: AgentInfo[]; createThread?: () => Promise<ThreadSummary>; prompt?: () => AsyncIterable<unknown> } = {}) => {
  const calls: string[] = [];
  const released: ReleaseOptions[] = [];
  let written = '';
  let picker: PickerRequest | undefined;
  let claimed = 0;
  let keys: ((data: string) => boolean) | undefined;
  let threads = 0;
  const live = new Set<string>();
  const client = {
    listAgents: () => Promise.resolve(daemon.agents ?? AGENTS),
    connect: () => Promise.resolve({ protocolVersion: 2, daemonVersion: '0', pid: 1 }),
    createThread: () => {
      if (daemon.createThread) {
        return daemon.createThread();
      }
      const id = `t${++threads}`;
      live.add(id);
      calls.push(`create ${id}`);
      return Promise.resolve(summary(id));
    },
    attachThread: (id: string) => Promise.resolve({ thread: summary(id), history: [] }),
    threadModes: () => Promise.resolve(MODES),
    deleteThread: (id: string) => {
      live.delete(id);
      calls.push(`delete ${id}`);
      return Promise.resolve();
    },
    detachThread: () => Promise.resolve(),
    listThreads: () => Promise.resolve([]),
    prompt: () => daemon.prompt?.() ?? (async function* () {})(),
    setMode: (id: string, mode: string) => {
      calls.push(`mode ${id} ${mode}`);
      return Promise.resolve();
    },
  } as unknown as DaemonClient;
  const overlay = {
    mode: 'agent',
    isOpen: true,
    close: () => calls.push('close'),
    setBusy: () => undefined,
    setError: (message: string) => calls.push(`error ${message}`),
    setHint: () => undefined,
    clearInput: () => undefined,
    openPicker: (request: PickerRequest) => (picker = request),
    closePicker: () => (picker = undefined),
  };
  const host = {
    terminal: {
      write: (data: string) => (written += data),
      size: { cols: 80, rows: 24 },
      queryCursorPosition: () => Promise.resolve({ row: 1, col: 1 }),
    },
    colorDepth: 'none',
    overlay,
    link: { get: () => Promise.resolve(client), loaded: client, lastError: undefined },
    commands: { recent: () => Promise.resolve([]), cwd: '/home' },
    lineEditor: undefined,
    home: '/home',
    configPath: '~/.shelly/config.json',
    recordsCommands: true,
    cwd: () => '/home',
    environment: () => Promise.resolve({ os: 'TestOS', shell: 'zsh', shellVersion: undefined, terminal: undefined }),
    claim: (_open: OpenInput, onKeys: (data: string) => boolean) => {
      keys = onKeys;
      return ++claimed;
    },
    release: (options: ReleaseOptions) => released.push(options),
    ...overrides,
  } as unknown as FlowHost;
  const session = new AgentSession(host);
  const open: OpenInput = { trigger: '::', mode: 'agent', rewrite: undefined };
  return { session, open, calls, released, written: () => written, text: () => written.replace(/\u001b\[[\d;?]*[A-Za-z]/g, ''), picker: () => picker, claimed: () => claimed, live, keys: (data: string) => keys?.(data), client: () => Promise.resolve(client) };
};

describe('AgentSession', () => {
  it('says in the hint that the agent for a new thread is not installed, and that there is none', async () => {
    const opencode: AgentInfo = { id: 'opencode', name: 'OpenCode', available: false, unavailableReason: "OpenCode isn't installed. Install it from opencode.ai, then try again.", supportsFast: true, isDefault: true };
    const t = setup({}, { agents: [opencode] });
    await t.session.connected(await t.client());
    assert.equal(t.session.openOptions().hint, 'OpenCode · not installed');

    const none = setup({}, { agents: [] });
    assert.equal(none.session.openOptions().hint, undefined, 'nothing is said before the daemon is heard');
    await none.session.connected(await none.client());
    assert.equal(none.session.openOptions().hint, 'no agent set up · /agent');
  });

  it('shows why a prompt was refused, with ✗ and nothing about trying the agent, and keeps no thread', async () => {
    const reason = "OpenCode isn't installed. Install it from opencode.ai, then try again.";
    const opencode: AgentInfo = { id: 'opencode', name: 'OpenCode', available: false, unavailableReason: reason, supportsFast: true, isDefault: true };
    const t = setup({}, { agents: [opencode], createThread: () => Promise.reject(new DaemonError('AgentUnavailable', { agentId: 'opencode', reason }, reason)) });
    t.session.submit(t.open, 'hello');
    for (let i = 0; i < 50 && t.released.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(t.released.length, 1, 'the prompt came back');
    assert.match(t.text(), /✗ OpenCode isn't installed\. Install it from opencode\.ai, then try again\.\r\n/);
    assert.doesNotMatch(t.text(), /Try again, or check|<1s|✓|\/agent/);
  });

  it('deletes the thread it made for a prompt that never became a turn, and starts a new one for the retry', async () => {
    const reason = "Fake can't start.";
    const other: AgentInfo = { id: 'other', name: 'Other', available: true, unavailableReason: null, supportsFast: false, isDefault: false };
    const t = setup({}, {
      agents: [...AGENTS, other],
      prompt: () => (async function* () {
        throw new DaemonError('AgentUnavailable', { agentId: 'fake', reason }, reason);
      })(),
    });
    for (const attempt of [1, 2]) {
      t.session.submit(t.open, 'hello');
      for (let i = 0; i < 50 && t.released.length < attempt; i++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.equal(t.released.length, attempt);
    }
    assert.deepEqual(t.calls.filter((call) => /^(create|delete)/.test(call)), ['create t1', 'delete t1', 'create t2', 'delete t2']);
    assert.equal(t.live.size, 0, 'no thread is left behind');
    // Another agent can be used: the message says where to pick it.
    assert.match(t.text(), /✗ Fake can't start\. · \/agent to pick another/);
  });

  it('names the agent as the user knows it, not by its id', async () => {
    const t = setup();
    await t.session.connected(await t.client());
    assert.equal(t.session.openOptions().hint, 'Fake · new thread');
  });

  it('gives the terminal back, with the error inline, when printing fails after it took it', async () => {
    const t = setup({ environment: () => Promise.reject(new Error('the environment is gone')) });
    t.session.submit(t.open, '/context');
    for (let i = 0; i < 5; i++) {
      await tick();
    }
    assert.equal(t.claimed(), 1);
    assert.equal(t.released.length, 1, 'released exactly once');
    assert.match(t.written(), /✗ the environment is gone/);
  });

  it('gives the terminal back at once on Ctrl-C while a slash command is still getting its text, and prints nothing after', async () => {
    let environment!: (value: unknown) => void;
    const t = setup({ environment: () => new Promise((resolve) => (environment = resolve)) } as unknown as Partial<FlowHost>);
    t.session.submit(t.open, '/context');
    await tick();
    assert.equal(t.claimed(), 1);
    assert.equal(t.keys('a'), false, 'other keys wait for the shell');
    assert.equal(t.keys('\u0003'), true, 'Ctrl-C is acted on');
    await tick();
    assert.equal(t.released.length, 1, 'the prompt is back without waiting');
    const before = t.written();
    environment({ os: 'TestOS', shell: 'zsh', shellVersion: undefined, terminal: undefined });
    for (let i = 0; i < 5; i++) {
      await tick();
    }
    assert.equal(t.written(), before, 'nothing printed after the prompt came back');
    assert.equal(t.released.length, 1);
  });

  it('shows /mode for a new thread without leaving a thread behind, and sets the pick when the thread starts', async () => {
    const t = setup();
    t.session.submit(t.open, '/mode');
    for (let i = 0; i < 10 && !t.picker(); i++) {
      await tick();
    }
    assert.ok(t.picker(), 'the picker opened');
    assert.deepEqual(t.picker()!.items.map((item) => item.id), ['default', 'plan']);
    assert.equal(t.live.size, 0, 'the thread used to read the modes is gone');
    // Esc: nothing changes, nothing is left.
    t.picker()!.onClose();
    assert.equal(t.live.size, 0);

    // Picking keeps the mode for the next thread, without starting one.
    t.session.submit(t.open, '/mode');
    for (let i = 0; i < 10 && !t.picker(); i++) {
      await tick();
    }
    const before = t.calls.filter((call) => call.startsWith('create')).length;
    t.picker()!.onPick({ id: 'plan', label: 'Plan' });
    assert.equal(t.calls.filter((call) => call.startsWith('create')).length, before, 'no thread for picking');
  });
});
