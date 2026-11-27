import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { DaemonClient } from '../../src/client/daemon-client.js';
import { isProcessAlive } from '../../src/daemon/lock.js';
import type { PromptContext, ThreadEvent } from '../../src/protocol/schema.js';

/*
 * The daemon with its real agent layers (the ACP runtime and fast mode), as
 * a terminal starts it, driving the fake ACP agent registered in
 * config.json. Every daemon started here is stopped before the file ends.
 */

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const ENTRY = join(ROOT, 'src', 'index.ts');
const TSX = import.meta.resolve('tsx');
const FAKE_AGENT = join(ROOT, 'test', 'fixtures', 'fake-agent', 'fake-acp-agent.ts');

const CONTEXT: PromptContext = {
  cwd: '/work/app',
  environment: { os: 'TestOS', shell: 'zsh', shellVersion: null, terminal: null },
  commands: [],
};

const homes: string[] = [];
const clients: DaemonClient[] = [];
const pids = new Set<number>();

after(async () => {
  for (const client of clients) {
    await client.shutdown(false).catch(() => undefined);
    await client.dispose().catch(() => undefined);
  }
  for (const pid of pids) {
    for (let waited = 0; waited < 5000 && isProcessAlive(pid); waited += 50) {
      await sleep(50);
    }
    if (isProcessAlive(pid)) {
      process.kill(pid, 'SIGKILL');
    }
  }
  for (const home of homes) {
    rmSync(home, { recursive: true, force: true });
  }
});

const startDaemon = async (config: object): Promise<DaemonClient> => {
  const home = mkdtempSync(join(tmpdir(), 'shg-'));
  homes.push(home);
  writeFileSync(join(home, 'config.json'), JSON.stringify(config));
  const client = new DaemonClient({
    env: { ...process.env, SHELLY_HOME: home },
    entry: ENTRY,
    execArgv: ['--experimental-ffi', '--no-warnings', '--import', TSX],
    startTimeoutMs: 20_000,
  });
  clients.push(client);
  pids.add((await client.connect()).pid);
  return client;
};

const fakeAgent = (scenario: string, extra: object = {}) => ({
  name: 'Fake Agent',
  command: process.execPath,
  args: ['--import', TSX, FAKE_AGENT, '--scenario', scenario],
  ...extra,
});

const collect = async (events: AsyncIterable<ThreadEvent>): Promise<ThreadEvent[]> => {
  const all: ThreadEvent[] = [];
  for await (const event of events) {
    all.push(event);
  }
  return all;
};

describe('the daemon with its real agent layers', { timeout: 60_000 }, () => {
  it('runs a turn on an ACP agent from config.json, on the configured model', async () => {
    const client = await startDaemon({ defaultAgent: 'fake', agents: { fake: fakeAgent('all', { model: 'fake-small' }) } });
    const agents = await client.listAgents();
    assert.deepEqual(agents.find((agent) => agent.id === 'fake'), {
      id: 'fake', name: 'Fake Agent', available: true, unavailableReason: null, supportsFast: false, isDefault: true,
    });

    const thread = await client.createThread({ location: 'home', cwd: '/work/app' });
    await client.attachThread(thread.id);
    const modes = await client.threadModes(thread.id);
    assert.deepEqual(modes?.availableModes.map((mode) => mode.id), ['default', 'acceptEdits', 'plan']);

    const events = await collect(client.prompt(thread.id, 'show me some markdown', CONTEXT));
    assert.equal(events[0]?.type, 'turn.started');
    const text = events.flatMap((event) => (event.type === 'message.chunk' ? [event.text] : [])).join('');
    assert.match(text, /That is everything/);
    const ended = events.at(-1);
    assert.equal(ended?.type === 'turn.ended' && ended.stopReason, 'end_turn');
    assert.equal((await client.listThreads())[0]?.title, 'show me some markdown');
  });
});
