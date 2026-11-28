import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { shellyPaths } from '../protocol/paths.js';

/*
 * The terminal side's log, `logs/client.log`: errors Shelly carried on
 * after, for a bug report. Only what went wrong and where (message and
 * stack), never what the user typed or what a command printed. Kept small:
 * past about 1 MB it moves to `client.log.1`.
 */

const MAX_BYTES = 1_000_000;

export const clientLogPath = (env: NodeJS.ProcessEnv = process.env): string => join(shellyPaths(env).logs, 'client.log');

/** Append one error; never throws (a log that cannot be written is not worth the shell). */
export const logClientError = (what: string, error: unknown, env: NodeJS.ProcessEnv = process.env): void => {
  try {
    const path = clientLogPath(env);
    mkdirSync(join(path, '..'), { recursive: true });
    try {
      if (statSync(path).size > MAX_BYTES) {
        renameSync(path, `${path}.1`);
      }
    } catch {
      // No log yet.
    }
    const detail = error instanceof Error ? error.stack ?? `${error.name}: ${error.message}` : String(error);
    appendFileSync(path, `${new Date().toISOString()} pid ${process.pid} ${what}: ${detail}\n`);
  } catch {
    // Nowhere to write it.
  }
};
