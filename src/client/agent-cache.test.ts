import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import type { AgentInfo } from '../protocol/schema.js';
import { readKnownAgents, writeKnownAgents } from './agent-cache.js';

const AGENTS: AgentInfo[] = [{ id: 'claude', name: 'Claude Code', available: true, unavailableReason: null, supportsFast: true, isDefault: true }];

describe('agent cache', () => {
  const homes: string[] = [];
  const home = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'shelly-agent-cache-'));
    homes.push(dir);
    return dir;
  };
  afterEach(() => homes.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

  it('writes the agents only you can read, and reads them back', () => {
    const dir = home();
    writeKnownAgents(dir, AGENTS);
    const file = readdirSync(dir).find((name) => name.endsWith('.json'))!;
    assert.equal(statSync(join(dir, file)).mode & 0o777, 0o600);
    assert.deepEqual(readKnownAgents(dir, (id) => id), AGENTS);
  });

  it('leaves no temporary file behind when it cannot put the cache in place', () => {
    const dir = home();
    // A directory where the cache file goes: the rename onto it fails.
    writeKnownAgents(dir, AGENTS);
    const file = readdirSync(dir).find((name) => name.endsWith('.json'))!;
    rmSync(join(dir, file));
    mkdirSync(join(dir, file));
    writeFileSync(join(dir, file, 'keep'), '');
    writeKnownAgents(dir, [{ ...AGENTS[0]!, name: 'Changed' }]);
    assert.deepEqual(readdirSync(dir).filter((name) => name.endsWith('.tmp')), []);
  });
});
