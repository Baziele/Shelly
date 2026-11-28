import { randomBytes } from 'node:crypto';
import { chmodSync, closeSync, fchmodSync, fstatSync, mkdirSync, openSync, renameSync, statSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { shellyPaths } from '../protocol/paths.js';

/*
 * The terminal side's log, `logs/client.log`: errors Shelly carried on
 * after, for a bug report. Only what went wrong and where (message and
 * stack), never what the user typed or what a command printed; stacks
 * still name paths in the user's home, so the log is theirs alone (0600).
 * Kept small: past about 1 MB it moves to `client.log.1`. Written only when
 * something went wrong, so synchronously: it is there even if Shelly exits
 * right after.
 */

const MAX_BYTES = 1_000_000;
const PRIVATE = 0o600;

export const clientLogPath = (env: NodeJS.ProcessEnv = process.env): string => join(shellyPaths(env).logs, 'client.log');

/**
 * Move a full log aside. Every Shelly in every tab writes here, and two may
 * find it full at once: each moves it to a name of its own first (one
 * wins; the other finds it gone, and is done), then into place.
 */
const rotate = (path: string): void => {
  try {
    if (statSync(path).size <= MAX_BYTES) {
      return;
    }
  } catch {
    return; // No log yet.
  }
  const aside = `${path}.${process.pid}-${randomBytes(4).toString('hex')}`;
  try {
    renameSync(path, aside);
  } catch {
    return; // Another Shelly moved it first.
  }
  chmodSync(aside, PRIVATE);
  renameSync(aside, `${path}.1`);
};

/** Append one error; never throws (a log that cannot be written is not worth the shell). */
export const logClientError = (what: string, error: unknown, env: NodeJS.ProcessEnv = process.env): void => {
  try {
    const path = clientLogPath(env);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    rotate(path);
    const detail = error instanceof Error ? error.stack ?? `${error.name}: ${error.message}` : String(error);
    const fd = openSync(path, 'a', PRIVATE);
    try {
      if ((fstatSync(fd).mode & 0o077) !== 0) {
        // Written before logs were private.
        fchmodSync(fd, PRIVATE);
      }
      writeSync(fd, `${new Date().toISOString()} pid ${process.pid} ${what}: ${detail}\n`);
    } finally {
      closeSync(fd);
    }
  } catch {
    // Nowhere to write it.
  }
};
