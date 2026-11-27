import { appendFileSync, copyFileSync, mkdirSync, statSync, truncateSync } from 'node:fs';
import { dirname } from 'node:path';
import * as Cause from 'effect/Cause';
import * as Layer from 'effect/Layer';
import * as Logger from 'effect/Logger';

/*
 * The daemon's log, `logs/daemon.log`. When it passes about 5 MB it is
 * copied to `daemon.log.1` and emptied in place, so the daemon's own stdio
 * (opened in append mode on the same file) keeps working.
 *
 * Privacy: nothing that logs here may include prompt text, agent output or
 * command output. Log ids, counts, stop reasons and error categories only.
 */

export const MAX_LOG_BYTES = 5 * 1024 * 1024;

const formatPart = (part: unknown): string => {
  if (typeof part === 'string') {
    return part;
  }
  if (part instanceof Error) {
    return `${part.name}: ${part.message}`;
  }
  try {
    return JSON.stringify(part) ?? String(part);
  } catch {
    return String(part);
  }
};

export const makeFileLogger = (path: string, maxBytes = MAX_LOG_BYTES) => {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  let writesSinceCheck = Number.POSITIVE_INFINITY;
  const rotateIfLarge = (): void => {
    writesSinceCheck = 0;
    try {
      if (statSync(path).size >= maxBytes) {
        copyFileSync(path, `${path}.1`);
        truncateSync(path, 0);
      }
    } catch {
      // No file yet.
    }
  };
  return Logger.make<unknown, void>(({ message, logLevel, date, cause }) => {
    if (++writesSinceCheck > 50) {
      rotateIfLarge();
    }
    const parts = Array.isArray(message) ? message : [message];
    let line = `${date.toISOString()} ${logLevel.toUpperCase()} ${parts.map(formatPart).join(' ')}`;
    if (cause.reasons.length > 0) {
      line += `\n${Cause.pretty(cause)}`;
    }
    try {
      appendFileSync(path, `${line}\n`, { mode: 0o600 });
    } catch {
      // Logging must never take the daemon down.
    }
  });
};

/** Replace the default (console) logger with the file. */
export const layer = (path: string, maxBytes = MAX_LOG_BYTES): Layer.Layer<never> =>
  Logger.layer([makeFileLogger(path, maxBytes)]);
