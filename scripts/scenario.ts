/*
 * Runs a UI scenario against Shelly in a real pseudo-terminal and writes
 * numbered screenshots plus an index.html contact sheet.
 *
 *   node --import tsx scripts/scenario.ts <scenario-file> [--out dir] [--shell /bin/zsh] [--cols 100 --rows 30] [--scale 2]
 *
 * A scenario file default-exports `async (driver) => { ... }` (a
 * ScenarioDriver from test/tools/scenario.ts) and may export `options`
 * (DriverOptions) as defaults for the flags. See test/tools/README.md.
 */
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, extname, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { ScenarioDriver, type DriverOptions, type Step } from '../test/tools/scenario.js';

export type Scenario = (driver: ScenarioDriver) => Promise<void>;

const usage = 'usage: node --import tsx scripts/scenario.ts <scenario-file> [--out dir] [--shell /bin/zsh] [--cols 100 --rows 30] [--scale 2]';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: 'string' },
    shell: { type: 'string' },
    cols: { type: 'string' },
    rows: { type: 'string' },
    scale: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
});

const file = positionals[0];
if (values.help || !file) {
  console.error(usage);
  process.exit(values.help ? 0 : 2);
}

const scenarioPath = resolve(file);
if (!existsSync(scenarioPath)) {
  console.error(`scenario not found: ${file}`);
  process.exit(2);
}
const name = basename(scenarioPath, extname(scenarioPath)).replace(/\.scenario$/, '');
const module = await import(pathToFileURL(scenarioPath).href) as { default?: Scenario; options?: DriverOptions };
if (typeof module.default !== 'function') {
  console.error(`${file} must default-export an async function (driver) => { ... }`);
  process.exit(2);
}

const outDir = resolve(values.out ?? resolve(import.meta.dirname, '..', '.scenario-out', name));
mkdirSync(outDir, { recursive: true });
// Clear an earlier run's output, and nothing else.
for (const entry of readdirSync(outDir)) {
  if (/^\d{2,}-.*\.(png|txt|svg|html)$/.test(entry) || entry === 'index.html') {
    rmSync(resolve(outDir, entry));
  }
}

const number = (value: string | undefined): number | undefined => (value === undefined ? undefined : Number(value));
const defaults = module.options ?? {};
const options: DriverOptions = {
  ...defaults,
  shell: values.shell ?? defaults.shell,
  cols: number(values.cols) ?? defaults.cols,
  rows: number(values.rows) ?? defaults.rows,
  outDir,
  screenshot: { ...defaults.screenshot, ...(values.scale ? { scale: Number(values.scale) } : {}) },
};

let driver: ScenarioDriver | undefined;
let failure: unknown;
const started = Date.now();
try {
  driver = await ScenarioDriver.start(options);
  await module.default(driver);
} catch (error) {
  failure = error;
  if (driver && !driver.hasExited) {
    await driver.screenshot('failure').catch(() => undefined);
  }
}
const steps = driver?.steps ?? [];
await driver?.close();

const escape = (text: string): string =>
  text.replace(/[&<>"]/g, (c) => `&${{ '&': 'amp', '<': 'lt', '>': 'gt', '"': 'quot' }[c]};`);
const href = (path: string | undefined): string => (path ? escape(relative(outDir, path)) : '');

const stepHtml = (step: Step): string => {
  const image = step.files.png ?? step.files.svg;
  return `<section id="step-${step.index}">
  <h2><span class="n">${String(step.index).padStart(2, '0')}</span> ${escape(step.name)}</h2>
  ${image ? `<a href="${href(image)}"><img src="${href(image)}" alt="${escape(step.name)}"></a>` : '<p>(no image)</p>'}
  <details><summary>text · <a href="${href(step.files.txt)}">${href(step.files.txt)}</a></summary><pre>${escape(step.text)}</pre></details>
</section>`;
};

const seconds = ((Date.now() - started) / 1000).toFixed(1);
const status = failure
  ? `<p class="fail">Failed: ${escape(failure instanceof Error ? failure.message : String(failure))}</p>`
  : `<p class="ok">Passed in ${seconds}s</p>`;
writeFileSync(resolve(outDir, 'index.html'), `<!doctype html>
<html><head><meta charset="utf-8"><title>${escape(name)} · Shelly scenario</title>
<style>
body { font: 14px/1.4 -apple-system, system-ui, sans-serif; margin: 24px; background: #f4f4f4; color: #222; }
h1 { margin: 0 0 4px; } .meta { color: #666; margin: 0 0 16px; }
.ok { color: #2a7a2a; } .fail { color: #b00020; white-space: pre-wrap; font-family: Menlo, monospace; }
section { background: #fff; border: 1px solid #ddd; border-radius: 6px; padding: 12px; margin: 0 0 16px; }
h2 { font-size: 15px; margin: 0 0 8px; } .n { color: #888; font-family: Menlo, monospace; }
img { max-width: 100%; border-radius: 4px; display: block; }
pre { background: #1e1e1e; color: #d4d4d4; padding: 8px; overflow-x: auto; font: 12px/1.3 Menlo, monospace; }
</style></head><body>
<h1>${escape(name)}</h1>
<p class="meta">${escape(relative(process.cwd(), scenarioPath))} · ${escape(driver?.shell ?? options.shell ?? 'default shell')} · ${options.cols ?? 100}×${options.rows ?? 30} · ${steps.length} steps</p>
${status}
${steps.map(stepHtml).join('\n')}
</body></html>
`);

for (const step of steps) {
  console.log(`${String(step.index).padStart(2, '0')} ${step.name}: ${step.files.png ?? step.files.svg}`);
  if (step.files.pngError) {
    console.log(`   no PNG: ${step.files.pngError}`);
  }
}
console.log(`contact sheet: ${resolve(outDir, 'index.html')}`);
if (failure) {
  console.error(failure instanceof Error ? failure.stack ?? failure.message : String(failure));
  process.exitCode = 1;
}
