import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as ManagedRuntime from 'effect/ManagedRuntime';
import * as Stream from 'effect/Stream';
import type { FastInput } from '../../protocol/schema.js';
import { FastService, ShellyConfig } from '../services.js';
import * as Fast from './fast-service.js';
import { readServiceState } from './opencode-server.js';

/*
 * Two real requests (one, then a follow-up) to the user's OpenCode, with the
 * default fast model. Costs a little: run with SHELLY_REAL_AGENTS=1. Leaves
 * no session behind; it starts OpenCode's background service if it is stopped.
 */
describe('FastService on the real OpenCode', { skip: process.env.SHELLY_REAL_AGENTS !== '1' }, () => {
  it('writes a command, then rewrites it in the same conversation', { timeout: 90_000 }, async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'shelly-real-')));
    const fastHome = join(home, 'fast');
    const runtime = ManagedRuntime.make(Fast.layer.pipe(Layer.provide(Layer.mergeAll(
      Layer.succeed(ShellyConfig, ShellyConfig.of({ get: Effect.succeed({}), setDefaultAgent: () => Effect.void })),
      Layer.succeed(Fast.FastSettings, { ...Fast.fastSettingsFromEnv(process.env), fastHome }),
    ))));
    const input = (instruction: string): FastInput => ({
      instruction,
      buffer: '',
      cwd: home,
      environment: { os: 'macOS 26.0.0 (arm64)', shell: 'zsh', shellVersion: null, terminal: null },
      recentCommands: [],
    });
    const ask = (instruction: string) => runtime.runPromise(FastService.use((fast) =>
      Stream.runCollect(fast.request({ agentId: 'opencode', sessionKey: 'real', input: input(instruction) }))));
    try {
      await runtime.runPromise(FastService.use((fast) => fast.prewarm('opencode')));
      await new Promise((resolve) => setTimeout(resolve, 1500));

      const first = await ask('list the files here, largest first');
      const done = first.at(-1);
      assert.ok(done?.type === 'done' && done.kind === 'command' && /\bls\b/.test(done.text), JSON.stringify(done));
      assert.ok(first.some((event) => event.type === 'delta'));
      console.log(`first: ${JSON.stringify(done.text)} in ${done.durationMs} ms`);

      const second = (await ask('now only the 5 largest')).at(-1);
      assert.ok(second?.type === 'done' && second.kind === 'command' && /\bls\b/.test(second.text) && /\b(head|tail)\b/.test(second.text), JSON.stringify(second));
      console.log(`follow-up: ${JSON.stringify(second.text)} in ${second.durationMs} ms`);
    } finally {
      await runtime.dispose();
      // Every fast session was deleted.
      const service = readServiceState(process.env);
      if (service) {
        const cwd = join(fastHome, 'opencode');
        const response = await fetch(`${service.url}/api/session?directory=${encodeURIComponent(cwd)}&limit=100`, {
          headers: { authorization: `Basic ${Buffer.from(`opencode:${service.password}`, 'utf8').toString('base64')}` },
        });
        const page = await response.json() as { data: { location?: { directory?: string } }[] };
        assert.equal(page.data.filter((session) => session.location?.directory === cwd).length, 0, 'fast sessions left behind');
      }
      rmSync(home, { recursive: true, force: true });
    }
  });
});
