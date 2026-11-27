import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import * as acp from '@agentclientprotocol/sdk';
import { MARKDOWN } from '../fixtures/fake-agent/scenarios/markdown-showcase.js';

const AGENT = fileURLToPath(new URL('../fixtures/fake-agent/fake-acp-agent.ts', import.meta.url));
const SCENARIOS = fileURLToPath(new URL('../fixtures/fake-agent/scenarios/', import.meta.url));
const TSX = import.meta.resolve('tsx');

interface FakeClient {
  readonly agent: acp.ClientContext;
  readonly updates: acp.SessionNotification[];
  readonly permissionRequests: acp.RequestPermissionRequest[];
  /** How the client answers permission requests. */
  answer: (request: acp.RequestPermissionRequest) => acp.RequestPermissionResponse | Promise<acp.RequestPermissionResponse>;
  /** Initialize and open a session. */
  start(): Promise<{ init: acp.InitializeResponse; session: acp.NewSessionResponse }>;
  prompt(sessionId: string, text: string): Promise<acp.PromptResponse>;
  /** All agent message text received for a session, in order. */
  messageText(sessionId: string): string;
  close(): Promise<void>;
}

const running: ChildProcess[] = [];
after(() => {
  for (const child of running) {
    child.kill();
  }
});

/** Spawns the fake agent with a scenario and connects a minimal ACP client to it. */
const connect = (scenario: string | undefined, { env = {}, args = [] }: { env?: Record<string, string>; args?: string[] } = {}): FakeClient => {
  const child = spawn(process.execPath, ['--import', TSX, AGENT, ...(scenario ? ['--scenario', scenario] : []), ...args], {
    stdio: ['pipe', 'pipe', 'inherit'],
    env: { ...process.env, ...env },
  });
  running.push(child);
  const updates: acp.SessionNotification[] = [];
  const permissionRequests: acp.RequestPermissionRequest[] = [];
  const client: FakeClient = {
    agent: undefined as unknown as acp.ClientContext,
    updates,
    permissionRequests,
    answer: () => ({ outcome: { outcome: 'cancelled' } }),
    async start() {
      const init = await client.agent.request('initialize', {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
        clientInfo: { name: 'fake-agent-test', version: '0' },
      });
      const session = await client.agent.request('session/new', { cwd: tmpdir(), mcpServers: [] });
      return { init, session };
    },
    prompt: (sessionId, text) => client.agent.request('session/prompt', { sessionId, prompt: [{ type: 'text', text }] }),
    messageText: (sessionId) => updates
      .filter((n) => n.sessionId === sessionId && n.update.sessionUpdate === 'agent_message_chunk')
      .map((n) => (n.update as { content: acp.ContentBlock }).content)
      .map((content) => (content.type === 'text' ? content.text : ''))
      .join(''),
    async close() {
      connection.close();
      child.stdin!.end();
      await new Promise((resolve) => child.once('exit', resolve).exitCode !== null && resolve(undefined));
    },
  };
  const connection = acp.client({ name: 'fake-agent-test' })
    .onNotification('session/update', ({ params }) => {
      updates.push(params);
    })
    .onRequest('session/request_permission', ({ params }) => {
      permissionRequests.push(params);
      return client.answer(params);
    })
    .connect(acp.ndJsonStream(
      Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>,
    ));
  (client as { agent: acp.ClientContext }).agent = connection.agent;
  return client;
};

const kinds = (client: FakeClient): string[] => client.updates.map((n) => n.update.sessionUpdate);
const toolUpdates = (client: FakeClient, id: string) =>
  client.updates.map((n) => n.update).filter((u) =>
    (u.sessionUpdate === 'tool_call' || u.sessionUpdate === 'tool_call_update') && u.toolCallId === id) as Array<acp.ToolCallUpdate>;

describe('fake ACP agent', { timeout: 30_000, concurrency: true }, () => {
  it('advertises capabilities, modes and models, and echoes prompts exactly', async () => {
    const client = connect(join(SCENARIOS, 'all.ts'));
    try {
      const { init, session } = await client.start();
      assert.equal(init.protocolVersion, acp.PROTOCOL_VERSION);
      assert.equal(init.agentCapabilities?.loadSession, true);
      assert.deepEqual(init.agentCapabilities?.sessionCapabilities?.resume, {});
      assert.equal(session.sessionId, 'fake-session-1');
      assert.equal(session.modes?.currentModeId, 'default');
      assert.deepEqual(session.modes?.availableModes.map((m) => m.id), ['default', 'acceptEdits', 'plan']);
      const model = session.configOptions?.find((option) => option.category === 'model');
      assert.equal(model?.type === 'select' && model.currentValue, 'fake-large');

      const prompt = 'Line one\n  indented "quotes" & <tags> ünïcödé 🙂';
      assert.deepEqual(await client.prompt(session.sessionId, prompt), { stopReason: 'end_turn' });
      assert.equal(client.messageText(session.sessionId), prompt);
    } finally {
      await client.close();
    }
  });

  it('echoes the whole prompt as JSON on request, and finds bundled scenarios by name', async () => {
    const client = connect('echo');
    try {
      const { session } = await client.start();
      await client.agent.request('session/prompt', {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'context --json' }, { type: 'resource_link', uri: 'file:///tmp/a.txt', name: 'a.txt' }],
      });
      const text = client.messageText(session.sessionId);
      const json = JSON.parse(text.replace(/^```json\n|\n```$/g, '')) as acp.ContentBlock[];
      assert.deepEqual(json.map((block) => block.type), ['text', 'resource_link']);
    } finally {
      await client.close();
    }
  });

  it('streams markdown in many chunks that add up to the document', async () => {
    const client = connect(join(SCENARIOS, 'markdown-showcase.ts'));
    try {
      const { session } = await client.start();
      await client.prompt(session.sessionId, 'show me markdown');
      assert.equal(client.messageText(session.sessionId), MARKDOWN);
      assert.ok(kinds(client).filter((k) => k === 'agent_message_chunk').length > 20, 'streamed, not sent whole');
      assert.equal(kinds(client)[0], 'agent_thought_chunk');
    } finally {
      await client.close();
    }
  });

  it('reports tool calls with kinds, status changes, locations, output and diffs', async () => {
    const client = connect(join(SCENARIOS, 'tool-heavy.ts'));
    try {
      const { session } = await client.start();
      await client.prompt(session.sessionId, 'fix it');
      assert.deepEqual(toolUpdates(client, 'read-1').map((u) => u.status), ['pending', 'in_progress', 'completed']);
      assert.equal(toolUpdates(client, 'read-1')[0]?.kind, 'read');
      assert.equal(toolUpdates(client, 'search-1')[0]?.kind, 'search');
      assert.equal(toolUpdates(client, 'search-1').at(-1)?.locations?.length, 2);
      const exec = toolUpdates(client, 'exec-1');
      assert.equal(exec[0]?.kind, 'execute');
      const output = exec.at(-1)?.content?.[0];
      assert.ok(output?.type === 'content' && output.content.type === 'text' && output.content.text.split('\n').length > 5);
      const diff = toolUpdates(client, 'edit-1').at(-1)?.content?.[0];
      assert.ok(diff?.type === 'diff');
      assert.match(diff.newText, /Hello, \$\{name\}!/);
      assert.match(diff.oldText ?? '', /'Hello ' \+ name/);
      assert.match(client.messageText(session.sessionId), /all 3 tests pass/);
    } finally {
      await client.close();
    }
  });

  for (const [optionId, expectedStatus, expectedText] of [
    ['allow-once', 'completed', /allowed once/],
    ['allow-always', 'completed', /won't ask again/],
    ['reject-once', 'failed', /left `.env.example` alone/],
  ] as const) {
    it(`branches on the permission answer: ${optionId}`, async () => {
      const client = connect(join(SCENARIOS, 'permission.ts'));
      try {
        client.answer = () => ({ outcome: { outcome: 'selected', optionId } });
        const { session } = await client.start();
        assert.deepEqual(await client.prompt(session.sessionId, 'add a setting'), { stopReason: 'end_turn' });
        const [request] = client.permissionRequests;
        assert.equal(request?.toolCall.toolCallId, 'edit-env');
        assert.deepEqual(request?.options.map((o) => o.kind), ['allow_once', 'allow_always', 'reject_once']);
        assert.equal(toolUpdates(client, 'edit-env').at(-1)?.status, expectedStatus);
        assert.match(client.messageText(session.sessionId), expectedText);
        assert.equal(kinds(client).includes('current_mode_update'), optionId === 'allow-always');
      } finally {
        await client.close();
      }
    });
  }

  it('ends the turn as cancelled when the permission request is cancelled', async () => {
    const client = connect(join(SCENARIOS, 'permission.ts'));
    try {
      const { session } = await client.start();
      const turn = client.prompt(session.sessionId, 'add a setting');
      client.answer = async () => {
        await client.agent.notify('session/cancel', { sessionId: session.sessionId });
        return { outcome: { outcome: 'cancelled' } };
      };
      assert.deepEqual(await turn, { stopReason: 'cancelled' });
    } finally {
      await client.close();
    }
  });

  it('marks a failing tool as failed and keeps going', async () => {
    const client = connect(join(SCENARIOS, 'failing-tool.json'));
    try {
      const { session } = await client.start();
      assert.deepEqual(await client.prompt(session.sessionId, 'build'), { stopReason: 'end_turn' });
      assert.deepEqual(toolUpdates(client, 'build').map((u) => u.status), ['pending', 'in_progress', 'failed']);
      assert.match(client.messageText(session.sessionId), /typo/);
    } finally {
      await client.close();
    }
  });

  it('fails the prompt with a JSON-RPC error mid-turn', async () => {
    const client = connect(join(SCENARIOS, 'error-mid-turn.ts'));
    try {
      const { session } = await client.start();
      await assert.rejects(client.prompt(session.sessionId, 'go'), (error: { code?: number; message?: string }) =>
        error.code === -32603 && /overloaded/.test(error.message ?? ''));
      assert.match(client.messageText(session.sessionId), /^Starting on that/);
      assert.equal(toolUpdates(client, 'logs')[0]?.status, 'in_progress');
    } finally {
      await client.close();
    }
  });

  it('waits three seconds for the first token', async () => {
    const client = connect(join(SCENARIOS, 'slow-first-token.ts'));
    try {
      const { session } = await client.start();
      const started = Date.now();
      let firstAt = 0;
      const turn = client.prompt(session.sessionId, 'anything');
      while (client.updates.length === 0) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      firstAt = Date.now() - started;
      await turn;
      assert.ok(firstAt >= 2900 && firstAt < 4500, `first token after ${firstAt}ms`);
      assert.match(client.messageText(session.sessionId), /42/);
    } finally {
      await client.close();
    }
  });

  it('sends a plan and updates its entries', async () => {
    const client = connect(join(SCENARIOS, 'plan.ts'));
    try {
      const { session } = await client.start();
      await client.prompt(session.sessionId, 'plan it');
      const plans = client.updates.map((n) => n.update).filter((u) => u.sessionUpdate === 'plan') as acp.Plan[];
      assert.ok(plans.length >= 5);
      assert.ok(plans[0]!.entries.every((e) => e.status === 'pending'));
      assert.deepEqual(plans[2]!.entries.map((e) => e.status), ['completed', 'in_progress', 'pending', 'pending']);
      assert.ok(plans.at(-1)!.entries.every((e) => e.status === 'completed'));
    } finally {
      await client.close();
    }
  });

  it('stops streaming promptly on session/cancel', async () => {
    const client = connect(join(SCENARIOS, 'long-answer.ts'));
    try {
      const { session } = await client.start();
      const turn = client.prompt(session.sessionId, 'tell me everything');
      while (client.updates.length < 3) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const cancelledAt = Date.now();
      await client.agent.notify('session/cancel', { sessionId: session.sessionId });
      assert.deepEqual(await turn, { stopReason: 'cancelled' });
      assert.ok(Date.now() - cancelledAt < 300, 'resolved promptly');
      const count = client.updates.length;
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.equal(client.updates.length, count, 'no updates after the turn ended');
    } finally {
      await client.close();
    }
  });

  it('ends with the scripted stop reason', async () => {
    const client = connect(join(SCENARIOS, 'all.ts'));
    try {
      const { session } = await client.start();
      assert.deepEqual(await client.prompt(session.sessionId, 'please stop'), { stopReason: 'max_tokens' });
    } finally {
      await client.close();
    }
  });

  it('loads sessions: a stored history, the current conversation, and across restarts', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'fake-acp-state-'));
    try {
      const first = connect(join(SCENARIOS, 'all.ts'), { env: { FAKE_ACP_STATE_DIR: stateDir } });
      let sessionId: string;
      try {
        await first.start();
        const stored = await first.agent.request('session/load', { sessionId: 'from-before', cwd: tmpdir(), mcpServers: [] });
        assert.equal(stored.modes?.currentModeId, 'default');
        assert.deepEqual(kinds(first), ['user_message_chunk', 'agent_message_chunk']);

        ({ sessionId } = await first.agent.request('session/new', { cwd: tmpdir(), mcpServers: [] }));
        await first.prompt(sessionId, 'hello again');
        first.updates.length = 0;
        await first.agent.request('session/load', { sessionId, cwd: tmpdir(), mcpServers: [] });
        assert.deepEqual(kinds(first), ['user_message_chunk', 'agent_message_chunk']);
        assert.equal(first.messageText(sessionId), 'hello again');
      } finally {
        await first.close();
      }

      const second = connect(join(SCENARIOS, 'all.ts'), { env: { FAKE_ACP_STATE_DIR: stateDir } });
      try {
        await second.start();
        await second.agent.request('session/load', { sessionId, cwd: tmpdir(), mcpServers: [] });
        assert.equal(second.messageText(sessionId), 'hello again');
        const resumed = await second.agent.request('session/resume', { sessionId, cwd: tmpdir() });
        assert.equal(resumed.modes?.currentModeId, 'default');
      } finally {
        await second.close();
      }
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it('writes nothing but JSON-RPC to stdout', async () => {
    const child = spawn(process.execPath, ['--import', TSX, AGENT, '--scenario', 'tool-heavy'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, FAKE_ACP_DEBUG: '1' },
    });
    running.push(child);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (data) => (stdout += data));
    child.stderr.on('data', (data) => (stderr += data));
    child.stdin.end(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } })}\n`);
    await new Promise((resolve) => child.once('exit', resolve));
    const lines = stdout.trim().split('\n');
    assert.equal(lines.length, 1);
    assert.equal((JSON.parse(lines[0]!) as { id: number }).id, 1);
    assert.match(stderr, /\[fake-acp-agent\] initialize/);
  });
});
