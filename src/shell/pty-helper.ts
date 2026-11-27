import { chmodSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

let checked = false;

/**
 * node-pty starts shells through a small `spawn-helper` binary. Some package
 * managers install it without its executable bit, and every spawn then fails
 * with "posix_spawnp failed". Restore the bit once, before the first spawn.
 * Best effort: a read-only install is left as it is.
 */
export const ensurePtyHelperExecutable = (): void => {
  if (checked || process.platform === 'win32') {
    return;
  }
  checked = true;

  let root: string;
  try {
    root = dirname(createRequire(import.meta.url).resolve('node-pty/package.json'));
  } catch {
    return;
  }

  const candidates = [
    join(root, 'build', 'Release', 'spawn-helper'),
    join(root, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper'),
  ];
  for (const path of candidates) {
    try {
      const { mode } = statSync(path);
      if ((mode & 0o111) === 0) {
        chmodSync(path, mode | 0o755);
      }
    } catch {
      // Missing (another layout) or not ours to change.
    }
  }
};
