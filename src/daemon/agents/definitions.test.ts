import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { agentDefinitions, agentEnvironment, agentInfos, defaultAgentId } from './definitions.js';

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
    assert.deepEqual(mine, { id: 'mine', name: 'Mine', available: true, unavailableReason: null, supportsFast: true, isDefault: false });
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
    const bundled = agentDefinitions({}, empty).find((definition) => definition.id === 'claude');
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
});
