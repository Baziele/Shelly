import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, it } from 'node:test';

/*
 * Effect belongs to the daemon. The client (`shelly` in a terminal tab)
 * must never load it: it costs every tab about 40 MB. This walks every
 * import the client could make, static and dynamic, from its entry, and
 * fails on any of Effect's packages. A type-only import is erased, so it
 * does not count; anything else does. test/e2e/client-modules.e2e.ts checks
 * the same of a running client.
 */

const SRC = resolve(import.meta.dirname, '..');
const CLIENT_ENTRY = join(SRC, 'run-shelly.ts');

/** `import … from '…'`, `export … from '…'`, `import '…'` and `import('…')`, with whether it is type-only. */
const IMPORTS = /\b(?:import|export)\s+(type\s+)?(?:[\w*{}\s,$]*?\s+from\s+)?['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;

const isEffect = (specifier: string): boolean => specifier === 'effect' || specifier.startsWith('effect/') || specifier.startsWith('@effect/');

/** Every module the client can reach, with the chain of files that leads to each package it imports. */
const clientGraph = () => {
  const packages = new Map<string, string[]>();
  const seen = new Set<string>();
  const visit = (file: string, chain: string[]): void => {
    if (seen.has(file)) {
      return;
    }
    seen.add(file);
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(IMPORTS)) {
      const [, typeOnly, fromSpecifier, dynamicSpecifier] = match;
      const specifier = fromSpecifier ?? dynamicSpecifier!;
      if (typeOnly) {
        continue;
      }
      if (specifier.startsWith('.')) {
        const target = resolve(dirname(file), specifier.replace(/\.js$/, '.ts'));
        assert.ok(existsSync(target), `${relative(SRC, file)} imports ${specifier}, which is not there`);
        visit(target, [...chain, relative(SRC, target)]);
      } else if (!specifier.startsWith('node:') && !packages.has(specifier)) {
        packages.set(specifier, chain);
      }
    }
  };
  visit(CLIENT_ENTRY, [relative(SRC, CLIENT_ENTRY)]);
  return { files: seen, packages };
};

describe("the client's imports", () => {
  it('never reach Effect', () => {
    const { files, packages } = clientGraph();
    // The walk sees the lazily loaded parts too: the UI and the daemon connection.
    for (const file of ['ui/inline-overlay.ts', 'client/flows.ts', 'client/daemon-client.ts', 'client/rpc-connection.ts']) {
      assert.ok(files.has(join(SRC, file)), `${file} is reached`);
    }
    assert.ok(packages.has('@opentui/core'), 'packages are seen');
    const effect = [...packages].filter(([specifier]) => isEffect(specifier));
    assert.deepEqual(effect.map(([specifier, chain]) => `${specifier} via ${chain.join(' → ')}`), []);
  });

  it('reads type-only imports as erased, and every other kind as an import', () => {
    const source = [
      "import type { A } from 'effect/A';",
      "import { type B, C } from 'effect/C';",
      "import {\n  D,\n  E,\n} from './d.js';",
      "export { F } from './f.js';",
      "export type { G } from 'effect/G';",
      "import 'side-effect';",
      "const h = await import('./h.js');",
      "import * as I from '@effect/i';",
    ].join('\n');
    const found = [...source.matchAll(IMPORTS)].map(([, typeOnly, from, dynamic]) => `${typeOnly ? 'type ' : ''}${from ?? dynamic}`);
    assert.deepEqual(found, ['type effect/A', 'effect/C', './d.js', './f.js', 'type effect/G', 'side-effect', './h.js', '@effect/i']);
  });
});
