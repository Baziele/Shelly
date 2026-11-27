import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import type { AgentInfo } from '../protocol/schema.js';
import * as AgentDirectory from './AgentDirectory.js';
import { AgentRuntime, type ConfigFile, ShellyConfig } from './services.js';

const agent = (id: string, fields: Partial<AgentInfo> = {}): AgentInfo => ({
  id, name: id, available: true, unavailableReason: null, supportsFast: false, isDefault: false, ...fields,
});

const resolveFast = (agents: readonly AgentInfo[], file: ConfigFile, agentId?: string) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const directory = yield* AgentDirectory.AgentDirectory;
      return yield* directory.resolveFast(agentId);
    }).pipe(Effect.provide(AgentDirectory.layer.pipe(Layer.provide(Layer.mergeAll(
      Layer.succeed(AgentRuntime, AgentRuntime.of({
        agents: Effect.succeed(agents),
        session: () => Effect.die('unused'),
        prewarm: () => Effect.void,
        release: () => Effect.void,
        processCount: Effect.succeed(0),
      })),
      Layer.succeed(ShellyConfig, ShellyConfig.of({ get: Effect.succeed(file), setDefaultAgent: () => Effect.void })),
    ))))),
  );

describe('AgentDirectory.resolveFast', () => {
  it('uses the default agent when it has fast mode', async () => {
    assert.equal(await resolveFast([agent('claude', { supportsFast: true }), agent('opencode', { supportsFast: true })], { defaultAgent: 'opencode' }), 'opencode');
  });

  it('falls back to an available agent with fast mode when the default has none', async () => {
    const agents = [agent('mine', { isDefault: true }), agent('opencode', { supportsFast: true, available: false }), agent('claude', { supportsFast: true })];
    assert.equal(await resolveFast(agents, { defaultAgent: 'mine' }), 'claude');
  });

  it('keeps the default when nothing has fast mode, so its request says why', async () => {
    assert.equal(await resolveFast([agent('mine', { isDefault: true })], {}), 'mine');
  });

  it('uses the agent asked for', async () => {
    assert.equal(await resolveFast([agent('claude', { supportsFast: true })], {}, 'opencode'), 'opencode');
  });
});
