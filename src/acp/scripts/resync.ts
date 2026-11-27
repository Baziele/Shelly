// Shelly-only: re-sync src/acp from a T3 Code checkout. See src/acp/README.md.
//
//   node src/acp/scripts/resync.ts /path/to/t3code
//
// Copies upstream's packages/effect-acp over src/acp, then redoes every
// mechanical Shelly adaptation. Run it from the repository root and read
// `git diff`: what is left is upstream's change. Typecheck and test after.

import { execFileSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";

const t3 = process.argv[2];
if (t3 === undefined) throw new Error("usage: node src/acp/scripts/resync.ts /path/to/t3code");
const upstream = path.join(t3, "packages", "effect-acp");
const target = path.join("src", "acp");
if (!existsSync(path.join(upstream, "src", "client.ts"))) throw new Error(`no effect-acp at ${upstream}`);
if (!existsSync(path.join(target, "LICENSE"))) throw new Error("run from the Shelly repository root");

// Upstream path (relative to packages/effect-acp) -> our path (relative to src/acp).
const localPath = (rel: string) => (rel.startsWith("src/") ? rel.slice("src/".length) : rel);

const listTs = (dir: string): Array<string> =>
  readdirSync(path.join(upstream, dir), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => path.relative(upstream, path.join(entry.parentPath, entry.name)))
    .sort();

// 1. Copy upstream verbatim. Its package.json and tsconfig.json are T3 tooling.
cpSync(path.join(upstream, "src"), target, { recursive: true });
cpSync(path.join(upstream, "test", "fixtures"), path.join(target, "test", "fixtures"), {
  recursive: true,
});
copyFileSync(path.join(upstream, "scripts", "generate.ts"), path.join(target, "scripts", "generate.ts"));
copyFileSync(path.join(t3, "LICENSE"), path.join(target, "LICENSE"));

const replaceAll = (text: string, from: string | RegExp, to: string) =>
  typeof from === "string" ? text.split(from).join(to) : text.replace(from, to);

for (const rel of [...listTs("src"), ...listTs("test/fixtures"), ...listTs("scripts")]) {
  const file = path.join(target, localPath(rel));
  let text = readFileSync(file, "utf8");

  // 2. Relative .ts import specifiers become .js; our tsconfig rejects .ts ones.
  text = replaceAll(text, /((?:from|import) "\.{1,2}\/[^"]+)\.ts"/g, '$1.js"');
  text = replaceAll(text, /import\("(\.{1,2}\/[^"]+)\.ts"\)/g, 'import("$1.js")');

  // 3. Tests: the node:test shim replaces @effect/vitest, fixtures sit beside
  //    the sources, and the mock peer runs through tsx.
  if (rel.endsWith(".test.ts")) {
    const shim = rel.startsWith("src/_internal/") ? "../test/effect-vitest.js" : "./test/effect-vitest.js";
    text = replaceAll(text, 'from "@effect/vitest";', `from "${shim}";`);
  }
  text = replaceAll(text, '"../test/fixtures/', '"./test/fixtures/');
  text = replaceAll(
    text,
    "const mockPeerArgs = (path: string) => [path];",
    'const mockPeerArgs = (path: string) => ["--import", "tsx", path];',
  );
  text = replaceAll(text, '"../../src/agent.js"', '"../../agent.js"');
  // Upstream infers this type only under exactOptionalPropertyTypes.
  text = replaceAll(
    text,
    /^( *)const answer = action === "accept" \? \{ action, content: \{ choice: "yes" \} \} : \{ action \};$/m,
    '$1const answer: AcpSchema.CreateElicitationResponse =\n$1  action === "accept" ? { action, content: { choice: "yes" } } : { action };',
  );

  // 4. The generator writes to src/acp/_generated and formats with a pinned vite-plus.
  text = replaceAll(
    text,
    'path.join(import.meta.dirname, "..", "src", "_generated")',
    'path.join(import.meta.dirname, "..", "_generated")',
  );
  text = replaceAll(
    text,
    'ChildProcess.make("pnpm", ["exec", "vp", "fmt", generatedDir], {',
    'ChildProcess.make("pnpm", ["--package=vite-plus@1.8.0", "dlx", "vp", "fmt", generatedDir], {',
  );

  // 5. Credit upstream in each copied file, after a shebang if there is one.
  const header =
    "// Adapted from T3 Code's effect-acp (MIT License, see src/acp/LICENSE).\n" +
    `// Upstream: github.com/pingdotgg/t3code, packages/effect-acp/${rel} (pinned commit in src/acp/README.md).\n`;
  if (text.startsWith("#!")) {
    const lineEnd = text.indexOf("\n") + 1;
    text = `${text.slice(0, lineEnd)}\n${header}${text.slice(lineEnd)}`;
  } else {
    text = `${header}\n${text}`;
  }

  writeFileSync(file, text);
}

const commit = execFileSync("git", ["-C", t3, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
console.log(`Synced from ${commit}. Update the pinned commit in src/acp/README.md.`);
