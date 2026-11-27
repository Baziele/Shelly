import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import pkg from '../../package.json' with { type: 'json' };
import { SHELLY_VERSION } from '../version.js';
import * as DaemonLog from './DaemonLog.js';
import * as DaemonPaths from './DaemonPaths.js';
import { ShellyConfig } from './services.js';
import * as ShellyConfigFile from './ShellyConfigFile.js';
import { ensureThreadHome, THREAD_HOME_INSTRUCTIONS } from './thread-home.js';
import { initialTitle } from './titles.js';

const dirs: string[] = [];
after(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'shelly-support-'));
  dirs.push(dir);
  return dir;
};

const withConfig = <A>(home: string, body: (config: ShellyConfig['Service']) => Effect.Effect<A>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      return yield* body(yield* ShellyConfig);
    }).pipe(Effect.provide(ShellyConfigFile.layer.pipe(Layer.provide(DaemonPaths.layer({ SHELLY_HOME: home }))))),
  );

describe('ShellyConfig file', () => {
  it('reads a missing or broken file as empty', async () => {
    const home = tempDir();
    assert.deepEqual(await withConfig(home, (config) => config.get), {});
    writeFileSync(join(home, 'config.json'), '{ nope');
    assert.deepEqual(await withConfig(home, (config) => config.get), {});
    writeFileSync(join(home, 'config.json'), JSON.stringify({ defaultAgent: 7 }));
    assert.deepEqual(await withConfig(home, (config) => config.get), {});
  });

  it('writes the default agent atomically and keeps unknown keys', async () => {
    const home = tempDir();
    const path = join(home, 'config.json');
    writeFileSync(path, JSON.stringify({ theme: 'dark', agents: { claude: { fastModel: 'haiku' } } }));
    const read = await withConfig(home, (config) => config.setDefaultAgent('opencode').pipe(Effect.andThen(config.get)));
    assert.deepEqual(read, { defaultAgent: 'opencode', agents: { claude: { fastModel: 'haiku' } } });
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { theme: 'dark', agents: { claude: { fastModel: 'haiku' } }, defaultAgent: 'opencode' });
    assert.equal(statSync(path).mode & 0o777, 0o600);
  });
});

describe('thread home', () => {
  it('writes AGENTS.md and an identical CLAUDE.md, and leaves current ones alone', () => {
    const dir = join(tempDir(), 'home');
    assert.deepEqual(ensureThreadHome(dir), ['AGENTS.md', 'CLAUDE.md']);
    assert.equal(readFileSync(join(dir, 'AGENTS.md'), 'utf8'), THREAD_HOME_INSTRUCTIONS);
    assert.equal(readFileSync(join(dir, 'CLAUDE.md'), 'utf8'), THREAD_HOME_INSTRUCTIONS);
    assert.deepEqual(ensureThreadHome(dir), []);
    writeFileSync(join(dir, 'CLAUDE.md'), '<!-- shelly-instructions v0 -->\nold');
    assert.deepEqual(ensureThreadHome(dir), ['CLAUDE.md']);
  });
});

describe('initialTitle', () => {
  it('keeps short prompts and cuts long ones at a word', () => {
    assert.equal(initialTitle('  why did\nthe build fail?  '), 'why did the build fail?');
    const long = initialTitle('please look at the failing integration tests in the payments service and fix them');
    assert.ok(long.length <= 60);
    assert.equal(long, 'please look at the failing integration tests in the…');
  });
});

describe('daemon log', () => {
  it('rotates once the file passes the limit', async () => {
    const path = join(tempDir(), 'logs', 'daemon.log');
    await Effect.runPromise(
      Effect.gen(function* () {
        for (let index = 0; index < 200; index++) {
          yield* Effect.logInfo(`line ${index} ${'x'.repeat(40)}`);
        }
      }).pipe(Effect.provide(DaemonLog.layer(path, 2000))),
    );
    assert.ok(existsSync(`${path}.1`));
    assert.ok(statSync(path).size < 2000 + 60 * 60);
    assert.match(readFileSync(path, 'utf8'), /INFO line 199/);
  });
});

describe('version', () => {
  it('matches package.json', () => {
    assert.equal(SHELLY_VERSION, pkg.version);
  });
});
