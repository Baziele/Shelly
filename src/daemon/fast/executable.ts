import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';

/* Finding an agent's executable, shared by the fast-mode backends. */

export const isExecutableFile = (path: string): boolean => {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/**
 * The executable to run: `explicit` when it is a path, else the first
 * match for it (or `name`) on PATH, else the first of `fallbacks` (only
 * when nothing explicit was asked for). Null when none.
 */
export const findExecutable = (
  name: string,
  explicit: string | null,
  env: NodeJS.ProcessEnv,
  fallbacks: readonly string[],
): string | null => {
  const wanted = explicit ?? name;
  if (wanted.includes('/')) return isExecutableFile(wanted) ? wanted : null;
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (dir === '') continue;
    const candidate = join(dir, wanted);
    if (isExecutableFile(candidate)) return candidate;
  }
  if (explicit !== null) return null;
  return fallbacks.find(isExecutableFile) ?? null;
};
