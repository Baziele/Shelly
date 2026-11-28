import { randomBytes } from 'node:crypto';
import {
  appendFileSync, chmodSync, closeSync, fchmodSync, fstatSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, statSync,
  unlinkSync, writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { shellyPaths } from '../protocol/paths.js';

/*
 * The terminal side's log, `logs/client.log`: errors Shelly carried on
 * after, for a bug report. An error's message is free text, and can carry
 * what the user asked or what a command printed (a decode error echoing a
 * value, say), so only part of it is kept: its name, the first line of its
 * message cut short, and its stack frames (which name files, in the
 * user's home among others). The log is the user's alone (0600). Kept
 * small: past about 1 MB it moves to `client.log.1`. Written only when
 * something went wrong, so synchronously: it is there even if Shelly exits
 * right after.
 */

const MAX_BYTES = 1_000_000;
const PRIVATE = 0o600;
/** How much of an error's message is kept. */
const MESSAGE_CHARS = 200;

export const clientLogPath = (env: NodeJS.ProcessEnv = process.env): string => join(shellyPaths(env).logs, 'client.log');

/** The first line of a message, cut short: the part that says what went wrong, not the value it was about. */
const cut = (message: string): string => {
  const line = message.split(/\r?\n/, 1)[0] ?? '';
  return line.length > MESSAGE_CHARS ? `${line.slice(0, MESSAGE_CHARS)}…` : line;
};

/** What the log keeps of an error: see the top of this file. */
export const describeForLog = (error: unknown): string => {
  if (!(error instanceof Error)) {
    return cut(String(error));
  }
  const frames = (error.stack ?? '').split('\n').filter((line) => /^\s+at /.test(line));
  return [`${error.name}: ${cut(error.message)}`, ...frames].join('\n');
};

const removeQuietly = (path: string): void => {
  try {
    unlinkSync(path);
  } catch {
    // Gone already.
  }
};

/**
 * Move a full log aside. Every Shelly in every tab writes here, and two may
 * find it full at once. Each takes it under a name of its own first (one
 * wins; the other finds it gone, and is done), then checks it took the
 * full log it saw: another Shelly may have rotated it in between and
 * started a new one, which goes back. Nothing is left under the name of
 * its own, whatever fails. `taking` runs just before the take (a test seam).
 */
export const rotateClientLog = (path: string, taking?: () => void): void => {
  let seen;
  try {
    seen = statSync(path);
  } catch {
    return; // No log yet.
  }
  if (seen.size <= MAX_BYTES) {
    return;
  }
  taking?.();
  const aside = `${path}.${process.pid}-${randomBytes(4).toString('hex')}`;
  try {
    renameSync(path, aside);
  } catch {
    return; // Another Shelly moved it first.
  }
  try {
    const taken = statSync(aside);
    if (taken.ino === seen.ino && taken.dev === seen.dev) {
      renameSync(aside, `${path}.1`);
      chmodSync(`${path}.1`, PRIVATE);
      return;
    }
    // A newer log: back where it was, unless a newer one still has started there.
    try {
      linkSync(aside, path);
    } catch {
      appendFileSync(path, readFileSync(aside), { mode: PRIVATE });
    }
  } finally {
    removeQuietly(aside);
  }
};

/** Append one error; never throws (a log that cannot be written is not worth the shell). */
export const logClientError = (what: string, error: unknown, env: NodeJS.ProcessEnv = process.env): void => {
  try {
    const path = clientLogPath(env);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    try {
      rotateClientLog(path);
    } catch {
      // Still log, to the full file.
    }
    const fd = openSync(path, 'a', PRIVATE);
    try {
      if ((fstatSync(fd).mode & 0o077) !== 0) {
        // Written before logs were private.
        fchmodSync(fd, PRIVATE);
      }
      writeSync(fd, `${new Date().toISOString()} pid ${process.pid} ${what}: ${describeForLog(error)}\n`);
    } finally {
      closeSync(fd);
    }
  } catch {
    // Nowhere to write it.
  }
};
