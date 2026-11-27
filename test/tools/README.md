# Test tooling: see and drive the real terminal UI

Three tools, so agents and reviewers can check Shelly's terminal UI the way a user sees it.

| Tool | File | What it's for |
| --- | --- | --- |
| Screenshots | `test/tools/screen.ts` | xterm-headless screen → text, PNG, SVG or HTML |
| Scenario driver and CLI | `test/tools/scenario.ts`, `scripts/scenario.ts` | Run Shelly in a real pty, type, press keys, wait, take screenshots |
| Fake ACP agent | `test/fixtures/fake-agent/` | A scriptable agent: streaming markdown, tools, diffs, permissions, errors |

Tests: `pnpm test` runs `test/tools/*.test.ts` (screenshots, fake agent); `pnpm test:e2e` runs `test/e2e/scenario-driver.e2e.ts`.

## Run a scenario and look at it

```sh
pnpm scenario test/tools/scenarios/context.scenario.ts            # or: node --import tsx scripts/scenario.ts <file>
pnpm scenario my.scenario.ts --shell /bin/bash --cols 100 --rows 30 --out /tmp/run
```

This writes `.scenario-out/<name>/NN-<step>.png` and `.txt` (the directory is gitignored), plus `index.html`, a contact sheet of every step in order. It prints every path. If something fails, there's a `failure` screenshot and the CLI exits 1. **Open the PNGs with your image-reading tool**: they're there to be looked at, not just generated.

A scenario file default-exports an async function that receives the driver. It may also export `options` (`DriverOptions`) as defaults:

```ts
import type { ScenarioDriver } from '../scenario.js';

export const options = { shell: '/bin/zsh', cols: 90, rows: 20 };

export default async (driver: ScenarioDriver) => {
  await driver.type('::');                       // types one character at a time (15 ms apart)
  await driver.waitForText(':: Ask Shelly');    // string or RegExp; default timeout 5 s
  await driver.screenshot('input-open');         // → 01-input-open.png + .txt
  await driver.type('/context');
  await driver.press('enter');                   // enter esc tab backspace up down left right ctrl-c ctrl-d ctrl-<x> alt-<x> …
  await driver.waitForStable({ quietMs: 300 });  // no output for 300 ms
  await driver.screenshot('context-shown');
};
```

## Driver API (`ScenarioDriver.start(options)`)

- **Options:** `shell` (default `/bin/zsh`), `cols`/`rows` (default 100×30), `env`, `outDir`, `home` (use your own HOME; otherwise a throwaway one is made, with startup files that set a `$ ` prompt), `files` (startup files for that throwaway HOME), `cwd`, `command` (run something other than Shelly), `screenshot` (render options).
- **Driving:** `type(text, { perCharDelayMs })`, `press(key, times?)`, `resize(cols, rows)`.
- **Reading:** `screen({ scrollback, cursor })` gives the text; `lines()`, `cursor()` (1-based), `raw()` (every byte Shelly wrote), and `terminal` (the xterm instance).
- **Waiting:** `waitForText(pattern, { timeoutMs, scrollback })`, `waitFor(predicate, description)`, `waitForStable({ quietMs })`, `waitForExit()`. A timed-out wait throws with the screen, and with a screenshot when there is an `outDir`.
- **Ending:** `screenshot(name)` returns a `Step` with the file paths; the driver keeps them all in `steps`. `close()` sends Ctrl+C, then `exit`, and kills only its own child after 3 s. It removes the throwaway HOME and SHELLY_HOME and returns the exit code.

The emulator answers cursor-position and device-attribute queries like a real terminal. It uses modern Unicode widths, so emoji take 2 cells. The environment is built from scratch: `PATH`, `HOME`, `SHELLY_HOME`, `TERM=xterm-256color`, `COLORTERM=truecolor`, `LANG`, `SHELL`. Nothing comes from your real home or dotfiles.

`test/e2e/harness.ts` (`startShelly`) is a thin wrapper over the driver for the older e2e tests.

## Screenshots without the driver

```ts
import { screenText, writeScreenshot, renderSvg, renderHtml, renderPng, readGrid, flush } from '../tools/screen.js';

await flush(terminal);                                // let xterm finish parsing
screenText(terminal, { scrollback: true, cursor: true });   // cursor shown as ▮ (cursorMarker to change it)
await writeScreenshot(terminal, '/tmp/shot', { extras: true }); // shot.txt + shot.png (+ .svg/.html)
readGrid(terminal).rows[0][3].fg;                     // resolved colours and attributes, for assertions
```

Rendering is cell-accurate: 14 px Menlo, 8.4 × 18 px cells, 8 px padding, PNG at 2× by default. Box-drawing (light, heavy, double, rounded) and block characters are drawn as shapes, so borders join up. Supported: default fg/bg, 16/256/truecolor, bold (bright for colours 0–7), dim, italic, underline, inverse, strikethrough, overline, invisible, wide CJK and emoji, and the cursor (hidden when the app hides it).

**The PNG route:** the SVG is rasterised by macOS Quick Look (`qlmanage -t -s <px>`, built in, using WebKit and the system fonts, so CJK and colour emoji work). Quick Look pads the image to a square, so `png.ts` (a tiny zlib-based PNG codec) crops it. `sips` cropping was unreliable. On other systems `rsvg-convert` is used if it's on PATH. With neither, `writeScreenshot` writes `.svg` and `.html` instead and puts the reason in `pngError`.

## Fake ACP agent

```sh
node --import tsx /abs/path/test/fixtures/fake-agent/fake-acp-agent.ts --scenario <file | bundled name> [--state-dir dir]
FAKE_ACP_SCENARIO=tool-heavy FAKE_ACP_DEBUG=1 node --import tsx …/fake-acp-agent.ts
```

stdout carries only JSON-RPC. Logs go to stderr, and only with `FAKE_ACP_DEBUG=1`. With no scenario, it echoes. To register it with Shelly through `$SHELLY_HOME/config.json`:

```json
{ "agents": { "fake": { "type": "acp", "command": "node",
  "args": ["--import", "tsx", "/abs/path/test/fixtures/fake-agent/fake-acp-agent.ts", "--scenario", "all"] } } }
```

Note: `--import tsx` resolves from the working directory, so start it from the repo, or pass tsx's absolute path.

**Bundled scenarios** (`scenarios/`, usable by name): `markdown-showcase`, `long-answer` (~60 tokens/s), `tool-heavy` (read, search, execute, edit with diff), `permission` (branches on allow once / always / reject), `failing-tool`, `error-mid-turn` (JSON-RPC -32603), `slow-first-token` (3 s), `plan`, `echo` (`--json` in the prompt echoes the raw blocks), and `all`, which picks one of the above by a word in the prompt: markdown, long, tools, permission, fail, error, slow, plan, or stop (`max_tokens`).

**Writing a scenario** (JSON, or TS with `export default defineScenario({...})`; types live in `types.ts`):

```ts
{
  capabilities: { loadSession: true, resume: true },  // or agentCapabilities: {...} (raw ACP)
  modes: { currentModeId: 'default', availableModes: [...] },
  models: { currentModelId: 'm1', availableModels: [{ modelId: 'm1', name: 'M1' }] }, // sent as a "model" config option
  history: { '*': [{ type: 'user', text: '…' }, { type: 'message', text: '…' }] },     // replayed by session/load
  rules: [{ match: 'deploy', script: [...] }, { match: { regex: '^fix' }, script: 'named' }],
  scripts: { named: [...] },
  defaultScript: [{ type: 'echo' }],
}
```

**Steps** (all take an optional `delayMs`):

- `message` and `thought`: `{ text, charsPerTick?, tickMs? }`.
- `user`.
- `echo`: `{ format: 'text' | 'json' }`.
- `tool_call`: `{ id, title, kind, status, locations, content }`. Content is `{type:'text', text}` or any ACP `ToolCallContent`, e.g. `{type:'diff', path, oldText, newText}`.
- `tool_update`: `{ id, status, … }`.
- `plan`: `{ entries }`.
- `mode`: `{ modeId }`.
- `update`: `{ update }`, any raw SessionUpdate.
- `permission`: `{ toolCall, options?, branches: { <optionId | kind | 'cancelled' | 'default'>: steps } }`.
- `error`: `{ code, message, data }`.
- `end`: `{ stopReason }`.
- `wait`: `{ ms }`.

`session/cancel` ends the turn within a tick, with `stopReason: "cancelled"`. `session/load` replays, in this order: the session's in-process history, then the `--state-dir` files, then `history[id]`, then `history['*']`.

`test/tools/fake-agent.test.ts` shows a minimal ACP client (the SDK's `client()` app API) driving each scenario.
