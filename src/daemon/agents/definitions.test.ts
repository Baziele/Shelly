import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { HOST_SESSION_VARIABLES } from '../claude-env.js';
import { claudeEnvironment } from '../fast/claude-worker.js';
import { agentDefinitions, agentEnvironment, agentInfos, defaultAgentId } from './definitions.js';
import type { ConfigFile } from '../services.js';

const bin = mkdtempSync(join(tmpdir(), 'shelly-bin-'));
after(() => rmSync(bin, { recursive: true, force: true }));
for (const name of ['claude', 'opencode', 'my-agent']) {
  writeFileSync(join(bin, name), '#!/bin/sh\n');
  chmodSync(join(bin, name), 0o755);
}
const withTools = { PATH: bin };
const empty = { PATH: join(bin, 'nowhere') };

describe('agent definitions', () => {
  it('lists the built-ins and custom agents, hiding disabled ones', () => {
    const config = {
      agents: {
        opencode: { enabled: false },
        mine: { name: 'Mine', command: 'my-agent', args: ['--acp'], fastModel: 'small' },
        broken: {},
      },
    };
    const infos = agentInfos(config, agentDefinitions(config, withTools));
    assert.deepEqual(infos.map((info) => info.id), ['claude', 'mine', 'broken']);
    const mine = infos.find((info) => info.id === 'mine');
    assert.deepEqual(mine, { id: 'mine', name: 'Mine', available: true, unavailableReason: null, supportsFast: false, isDefault: false });
    const broken = infos.find((info) => info.id === 'broken');
    assert.equal(broken?.available, false);
    assert.equal(broken?.supportsFast, false);
    assert.match(broken?.unavailableReason ?? '', /has no `command`/);
  });

  it('resolves commands on PATH only, without running anything', () => {
    const definitions = agentDefinitions({}, empty);
    const opencode = definitions.find((definition) => definition.id === 'opencode');
    assert.deepEqual(opencode?.launch, { ok: false, reason: "OpenCode isn't installed. Install it from opencode.ai, then try again." });
    const found = agentDefinitions({}, withTools).find((definition) => definition.id === 'opencode');
    assert.deepEqual(found?.launch, { ok: true, command: join(bin, 'opencode'), args: ['acp'] });
  });

  it("runs Claude Code through the bundled adapter, pointed at the user's claude", () => {
    const claude = agentDefinitions({}, withTools).find((definition) => definition.id === 'claude');
    assert.ok(claude?.launch.ok);
    assert.equal(claude.launch.command, process.execPath);
    assert.match(claude.launch.args[0] ?? '', /claude-agent-acp/);
    assert.equal(claude.env.CLAUDE_CODE_EXECUTABLE, join(bin, 'claude'));
    const bundled = agentDefinitions({}, { ...empty, HOME: join(bin, 'no-home') }).find((definition) => definition.id === 'claude');
    assert.equal(bundled?.env.CLAUDE_CODE_EXECUTABLE, undefined);
  });

  it('strips host Claude Code session variables from the env', () => {
    const claude = agentDefinitions({ agents: { claude: { env: { EXTRA: '1' } } } }, withTools)[0]!;
    const env = agentEnvironment(claude, {
      PATH: '/bin',
      CLAUDECODE: '1',
      CLAUDE_CODE_SESSION_ID: 'host',
      CLAUDE_CODE_MESSAGING_TOKEN: 'secret',
      HOME: '/home/user',
    });
    assert.deepEqual(env, { PATH: '/bin', HOME: '/home/user', CLAUDE_CODE_EXECUTABLE: join(bin, 'claude'), EXTRA: '1' });
  });

  it('strips the same host-session variables as fast mode, including CLAUDE_CODE_CHILD_NOTES_DIR', () => {
    const host = Object.fromEntries(HOST_SESSION_VARIABLES.map((name) => [name, 'from the host']));
    assert.ok(HOST_SESSION_VARIABLES.includes('CLAUDE_CODE_CHILD_NOTES_DIR'));
    const claude = agentDefinitions({}, withTools)[0]!;
    const agentEnv = agentEnvironment(claude, { PATH: '/bin', ...host });
    const fastEnv = claudeEnvironment({ PATH: '/bin', ...host });
    for (const name of HOST_SESSION_VARIABLES) {
      assert.equal(agentEnv[name], undefined, `agent mode kept ${name}`);
      assert.equal(fastEnv[name], undefined, `fast mode kept ${name}`);
    }
  });

  it('ignores an empty or stale inherited CLAUDE_CODE_EXECUTABLE', () => {
    for (const value of ['', '  ', join(bin, 'no-such-claude')]) {
      const env = { ...withTools, CLAUDE_CODE_EXECUTABLE: value };
      const claude = agentDefinitions({}, env)[0]!;
      assert.equal(claude.env.CLAUDE_CODE_EXECUTABLE, join(bin, 'claude'), `for ${JSON.stringify(value)}`);
      assert.equal(agentEnvironment(claude, env).CLAUDE_CODE_EXECUTABLE, join(bin, 'claude'));
    }
    // With no claude anywhere, the stale value doesn't reach the adapter: it uses its bundled claude.
    const nowhere = { ...empty, HOME: join(bin, 'no-home'), CLAUDE_CODE_EXECUTABLE: '/stale/claude' };
    const bundled = agentDefinitions({}, nowhere)[0]!;
    assert.equal(bundled.env.CLAUDE_CODE_EXECUTABLE, undefined);
    assert.equal(agentEnvironment(bundled, nowhere).CLAUDE_CODE_EXECUTABLE, undefined);
    // A real one is honoured.
    const mine = join(bin, 'my-agent');
    assert.equal(agentDefinitions({}, { ...withTools, CLAUDE_CODE_EXECUTABLE: mine })[0]!.env.CLAUDE_CODE_EXECUTABLE, mine);
  });

  it("finds the installer's claude in ~/.local/bin when it isn't on PATH", () => {
    const home = mkdtempSync(join(tmpdir(), 'shelly-home-'));
    try {
      mkdirSync(join(home, '.local', 'bin'), { recursive: true });
      writeFileSync(join(home, '.local', 'bin', 'claude'), '#!/bin/sh\n');
      chmodSync(join(home, '.local', 'bin', 'claude'), 0o755);
      const claude = agentDefinitions({}, { ...empty, HOME: home })[0]!;
      assert.equal(claude.env.CLAUDE_CODE_EXECUTABLE, join(home, '.local', 'bin', 'claude'));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('picks the default agent', () => {
    const definitions = agentDefinitions({}, withTools);
    assert.equal(defaultAgentId({}, definitions), 'claude');
    assert.equal(defaultAgentId({ defaultAgent: 'opencode' }, definitions), 'opencode');
    assert.equal(defaultAgentId({ defaultAgent: 'nobody' }, definitions), 'claude');
    const noClaude = { agents: { claude: { enabled: false } } };
    assert.equal(defaultAgentId(noClaude, agentDefinitions(noClaude, withTools)), 'opencode');
    const infos = agentInfos({}, definitions);
    assert.deepEqual(infos.filter((info) => info.isDefault).map((info) => info.id), ['claude']);
  });

  it('takes idle timeouts from the env', () => {
    const [claude, opencode] = agentDefinitions({}, { ...withTools, SHELLY_CLAUDE_SESSION_IDLE_MS: '10', SHELLY_AGENT_PROCESS_IDLE_MS: '20' });
    assert.deepEqual([claude?.sessionIdleMs, claude?.processIdleMs], [10, 20]);
    assert.deepEqual([opencode?.sessionIdleMs, opencode?.processIdleMs], [120_000, 20]);
    const [defaults] = agentDefinitions({}, withTools);
    assert.deepEqual([defaults?.sessionIdleMs, defaults?.processIdleMs], [180_000, 300_000]);
  });
  it('turns a configured model into session setup', () => {
    const config: ConfigFile = {
      agents: {
        claude: { model: 'haiku' },
        opencode: { model: 'opencode-go/hy4-flash-free' },
        mine: { command: 'my-agent', model: ' small ' },
        plain: { command: 'my-agent' },
      },
    };
    const setup = Object.fromEntries(agentDefinitions(config, withTools).map((definition) => [definition.id, definition.sessionSetup]));
    assert.deepEqual(setup.claude, { meta: { claudeCode: { options: { model: 'haiku' } } }, configOptions: { model: 'haiku' } });
    assert.deepEqual(setup.opencode, { configOptions: { model: 'opencode-go/hy4-flash-free' } });
    assert.deepEqual(setup.mine, { configOptions: { model: 'small' } });
    assert.deepEqual(setup.plain, {});
  });
});
