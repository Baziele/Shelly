/**
 * Records what Shelly's own ACP client exchanges with a real agent: the
 * daemon's AgentRuntime, its initialize (which negotiates ACP v2 with Claude
 * Code) and its session layout (the session in one folder, the user's project
 * as an additional directory). scripts/acp-probe.ts speaks plain v1 instead.
 *
 *   node --import tsx scripts/acp-record.ts --agent claude --scenario write
 *
 * Scenarios:
 *   write       Write a new three-line file in the project.        (one prompt)
 *   bash        Run a command with output and a failing exit.      (one prompt)
 *   signed-out  A prompt with Claude Code signed out: HOME and CLAUDE_CONFIG_DIR
 *               point at an empty folder. The agent refuses before any model call.
 *
 * Writes test/fixtures/acp/<agent>/shelly-<scenario>.ndjson, sanitized like the
 * probe's fixtures (scripts/acp-sanitize.ts). Prompts go to a small model:
 * haiku, or OpenCode's free model.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Runtime from "../src/daemon/agents/runtime.js";
import { AgentRuntime, type AgentSettings, type AgentUpdate, ShellyConfig } from "../src/daemon/services.js";
import { type Rec, sanitizer } from "./acp-sanitize.js";

const { values: argv } = parseArgs({
  options: {
    agent: { type: "string", default: "claude" },
    scenario: { type: "string" },
    model: { type: "string" },
  },
});
const agentId = argv.agent === "opencode" ? "opencode" : "claude";
const scenario = argv.scenario ?? "";
const PROMPTS: Record<string, (project: string) => string> = {
  write: (project) =>
    `Create ${project}/notes.txt containing exactly three lines: alpha, beta, gamma. Use your file write tool, no shell commands, do not ask me anything first, then reply with the word done.`,
  bash: () =>
    "Run exactly this shell command once with your shell tool, then reply with its exit code only: printf 'one\\ntwo\\nthree\\n'; echo oops >&2; exit 3",
  "signed-out": () => "Reply with OK.",
};
if (!PROMPTS[scenario]) throw new Error(`--scenario must be one of: ${Object.keys(PROMPTS).join(", ")}`);
if (scenario === "signed-out" && agentId !== "claude") throw new Error("signed-out is a Claude Code scenario");

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const home = realpathSync(mkdtempSync(join(tmpdir(), "acp-probe-")));
const project = realpathSync(mkdtempSync(join(tmpdir(), "acp-extra-")));
const emptyHome = scenario === "signed-out" ? realpathSync(mkdtempSync(join(tmpdir(), "acp-outside-"))) : undefined;

const settings: AgentSettings = emptyHome
  ? { env: { HOME: emptyHome, CLAUDE_CONFIG_DIR: join(emptyHome, ".claude") } }
  : {};
const model = argv.model ?? (agentId === "claude" ? "haiku" : "opencode-go/hy4-flash-free");
const options: Runtime.AgentRuntimeOptions = {
  sessionDefaults: agentId === "claude"
    ? { claude: { meta: { claudeCode: { options: { model } } } } }
    : { opencode: { configOptions: { model } } },
  onProtocolMessage: ({ direction, line }) => {
    records.push({ dir: direction, t: Math.round((performance.now() - origin) * 10) / 10, msg: JSON.parse(line) });
  },
};
const records: Rec[] = [];
const origin = performance.now();

const config = Layer.succeed(ShellyConfig, ShellyConfig.of({
  get: Effect.succeed({ agents: { [agentId]: settings } }),
  setDefaultAgent: () => Effect.void,
}));
const runtime = Runtime.layerWith(options).pipe(Layer.provide(Layer.mergeAll(config, NodeServices.layer)));

const program = Effect.gen(function* () {
  const agents = yield* AgentRuntime;
  const session = yield* agents.session({ agentId, threadId: "record", cwd: home, additionalDirectories: [project], nativeSessionId: null });
  const updates: AgentUpdate[] = [];
  yield* session.prompt(PROMPTS[scenario]!(project)).pipe(Stream.runForEach((update) => {
    updates.push(update);
    if (update.type === "permission") {
      const allow = update.options.find((option) => option.kind === "allow_once") ?? update.options[0];
      return session.respond(update.requestId, allow?.optionId ?? null).pipe(Effect.ignore);
    }
    return Effect.void;
  }));
  return updates;
}).pipe(Effect.scoped, Effect.provide(runtime));

try {
  const updates = await Effect.runPromise(program);
  const dirs: [string, string][] = [[project, "/tmp/extra"], [home, "/tmp/probe"], ...(emptyHome ? [[emptyHome, "/tmp/outside"] as [string, string]] : [])];
  const clean = sanitizer(dirs);
  const file = join(repoRoot, "test/fixtures/acp", agentId, `shelly-${scenario}.ndjson`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${clean.all(records).map((record) => JSON.stringify(record)).join("\n")}\n`);
  const end = updates.at(-1);
  const tools = updates.flatMap((update) => (update.type === "tool" ? [update.tool.kind] : []));
  process.stdout.write(`${JSON.stringify(clean.one({ dir: "in", t: 0, msg: { end, tools, fixture: file.replace(`${repoRoot}/`, "") } }).msg, null, 2)}\n`);
} finally {
  for (const dir of [home, project, emptyHome]) if (dir) rmSync(dir, { recursive: true, force: true });
}
