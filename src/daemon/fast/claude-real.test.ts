import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as ManagedRuntime from 'effect/ManagedRuntime';
import * as Stream from 'effect/Stream';
import { FastService, ShellyConfig } from '../services.js';
import * as Fast from './fast-service.js';

/* One real request to the user's Claude Code. Costs a little: run with SHELLY_REAL_AGENTS=1. */
describe('FastService on the real Claude Code', { skip: process.env.SHELLY_REAL_AGENTS !== '1' }, () => {
  it('writes a command', { timeout: 60_000 }, async () => {
    const home = mkdtempSync(join(tmpdir(), 'shelly-real-'));
    const runtime = ManagedRuntime.make(Fast.layer.pipe(Layer.provide(Layer.mergeAll(
      Layer.succeed(ShellyConfig, ShellyConfig.of({ get: Effect.succeed({}), setDefaultAgent: () => Effect.void })),
      Layer.succeed(Fast.FastSettings, { ...Fast.fastSettingsFromEnv(process.env), fastHome: join(home, 'fast') }),
    ))));
    try {
      const events = await runtime.runPromise(FastService.use((fast) => Stream.runCollect(fast.request({
        agentId: 'claude',
        sessionKey: 'real',
        input: {
          instruction: 'list the files here, largest first',
          buffer: '',
          cwd: home,
          environment: { os: 'macOS 25.0.0 (arm64)', shell: 'zsh', shellVersion: null, terminal: null },
          recentCommands: [],
        },
      }))));
      const done = events.at(-1);
      assert.equal(done?.type, 'done');
      assert.ok(done.type === 'done' && done.kind === 'command' && /\bls\b/.test(done.text), JSON.stringify(done));
      assert.ok(events.some((event) => event.type === 'delta'));
    } finally {
      await runtime.dispose();
      rmSync(home, { recursive: true, force: true });
    }
  });
});
