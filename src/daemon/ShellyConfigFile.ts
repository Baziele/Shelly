import { readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as Layer from 'effect/Layer';
import * as Schema from 'effect/Schema';
import * as Semaphore from 'effect/Semaphore';
import { DaemonPaths } from './DaemonPaths.js';
import { ConfigFile, ShellyConfig } from './services.js';

/*
 * ShellyConfig over `$SHELLY_HOME/config.json`. Reads decode the known keys;
 * writes change only what they are asked to and keep every other key the
 * user (or a later Shelly) put there. A write goes to a temporary file that
 * replaces the old one, so a crash never leaves half a file.
 */

const decode = Schema.decodeUnknownExit(ConfigFile);

type ReadResult =
  | { readonly kind: 'missing' }
  | { readonly kind: 'invalid'; readonly reason: string }
  | { readonly kind: 'ok'; readonly raw: Record<string, unknown> };

const readRaw = (path: string): ReadResult => {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? { kind: 'missing' }
      : { kind: 'invalid', reason: `unreadable (${(error as NodeJS.ErrnoException).code ?? 'error'})` };
  }
  try {
    const raw: unknown = JSON.parse(text);
    return raw !== null && typeof raw === 'object' && !Array.isArray(raw)
      ? { kind: 'ok', raw: raw as Record<string, unknown> }
      : { kind: 'invalid', reason: 'not a JSON object' };
  } catch {
    return { kind: 'invalid', reason: 'not valid JSON' };
  }
};

const writeAtomic = (path: string, value: unknown): void => {
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, path);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // Nothing to clean up.
    }
    throw error;
  }
};

export const layer: Layer.Layer<ShellyConfig, never, DaemonPaths> = Layer.effect(
  ShellyConfig,
  Effect.gen(function* () {
    const { config: path } = yield* DaemonPaths;
    const writes = yield* Semaphore.make(1);

    const get = Effect.gen(function* () {
      const result = readRaw(path);
      if (result.kind === 'missing') {
        return {};
      }
      if (result.kind === 'invalid') {
        yield* Effect.logWarning(`config.json ignored: ${result.reason}`);
        return {};
      }
      const decoded = decode(result.raw);
      if (Exit.isFailure(decoded)) {
        yield* Effect.logWarning('config.json ignored: it does not match the expected shape');
        return {};
      }
      return decoded.value;
    }).pipe(Effect.withSpan('ShellyConfig.get'));

    const setDefaultAgent = Effect.fn('ShellyConfig.setDefaultAgent')(function* (agentId: string) {
      yield* Effect.sync(() => {
        const current = readRaw(path);
        // An unreadable file is replaced rather than merged into: there is nothing to keep.
        const raw = current.kind === 'ok' ? current.raw : {};
        writeAtomic(path, { ...raw, defaultAgent: agentId });
      });
    }, (effect) => Semaphore.withPermit(writes, effect));

    return ShellyConfig.of({ get, setDefaultAgent });
  }),
);
