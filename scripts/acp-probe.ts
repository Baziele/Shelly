/**
 * ACP probe and fixture recorder.
 *
 * Spawns an ACP agent (claude-agent-acp or `opencode acp`), logs every
 * JSON-RPC message in both directions with a timestamp, and runs one named
 * scenario. Each scenario runs in a fresh throwaway directory under the OS
 * temp dir and writes a sanitized fixture to
 * test/fixtures/acp/<agent>/<scenario>[-lean].ndjson, one message per line:
 *
 *   {"dir":"out"|"in","t":<ms since spawn>,"msg":{...}}
 *
 * "out" is client -> agent, "in" is agent -> client. Scenarios that restart
 * the agent add `"proc":<n>` (1-based) to every line.
 *
 * Usage:
 *   node --import tsx scripts/acp-probe.ts --agent claude|opencode --scenario <name> [--lean]
 *
 * Options:
 *   --lean                 Claude: tools, MCP and settings off, short system
 *                          prompt, haiku. OpenCode: the `shelly-fast` agent from
 *                          an opencode.json in the probe dir.
 *   --caps fs|none|shelly  Client capabilities to offer (default fs). `shelly`
 *                          offers what the daemon does: no fs, no client
 *                          terminals, and `_meta.terminal_output_delta`, so
 *                          Claude Code reports command output in tool calls.
 *   --model <id>           Model (claude default "haiku", opencode default
 *                          "opencode-go/hy4-flash-free").
 *   --runs <n>             Runs for `latency` (default 3).
 *   --no-record            Do not write a fixture.
 *   --out <dir>            Fixture directory (default test/fixtures/acp).
 *   --claude-exe <path>    Sets CLAUDE_CODE_EXECUTABLE for claude-agent-acp.
 *   --keep                 Keep the probe directory.
 *   --verbose              Print every message to stderr as it passes.
 *   --resanitize           Re-run the sanitizer over the recorded fixtures.
 *
 * Scenarios: init, simple, tool, bash, permission-allow, permission-reject,
 * external, cancel, resume, latency, rss.
 *
 * Real prompts cost money: every scenario but `init` sends one to three tiny
 * prompts to a small model.
 */
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, hostname, tmpdir, userInfo } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { Readable, Writable } from "node:stream";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import {
  client,
  ndJsonStream,
  RequestError,
  type AnyMessage,
  type ClientConnection,
  type Stream,
} from "@agentclientprotocol/sdk/unstable";
import { withoutHostSession } from "../src/daemon/claude-env.js";

// ---------------------------------------------------------------------------
// CLI

type AgentName = "claude" | "opencode";
type Caps = "fs" | "none" | "shelly";

const { values: argv } = parseArgs({
  options: {
    agent: { type: "string" },
    scenario: { type: "string" },
    lean: { type: "boolean", default: false },
    caps: { type: "string", default: "fs" },
    model: { type: "string" },
    runs: { type: "string", default: "3" },
    "no-record": { type: "boolean", default: false },
    out: { type: "string" },
    "claude-exe": { type: "string" },
    keep: { type: "boolean", default: false },
    verbose: { type: "boolean", default: false },
    resanitize: { type: "boolean", default: false },
  },
});

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const agentName = argv.agent as AgentName;
const scenarioName = argv.scenario ?? "";
const lean = argv.lean ?? false;
const caps = (argv.caps ?? "fs") as Caps;
const model = argv.model ?? (agentName === "claude" ? "haiku" : "opencode-go/hy4-flash-free");
const fixtureRoot = argv.out ? resolve(argv.out) : join(repoRoot, "test/fixtures/acp");

const LEAN_SYSTEM_PROMPT =
  "You are a terse shell assistant inside a terminal. Answer in as few words as possible. No markdown.";
const FAST_AGENT = "shelly-fast";

// ---------------------------------------------------------------------------
// Recording

type Dir = "in" | "out";
type Rec = { dir: Dir; t: number; msg: AnyMessage; proc?: number };

class Recorder {
  readonly records: Rec[] = [];
  private listeners = new Set<(rec: Rec) => void>();
  proc = 1;
  multiProc = false;
  origin = performance.now();

  now(): number {
    return Math.round((performance.now() - this.origin) * 10) / 10;
  }

  push(dir: Dir, msg: AnyMessage): void {
    const rec: Rec = { dir, t: this.now(), msg };
    if (this.multiProc) rec.proc = this.proc;
    this.records.push(rec);
    if (argv.verbose) process.stderr.write(`${dir === "out" ? "->" : "<-"} ${rec.t} ${JSON.stringify(msg).slice(0, 300)}\n`);
    for (const l of this.listeners) l(rec);
  }

  /** Resolves with the first future record that matches. */
  waitFor(pred: (rec: Rec) => boolean, timeoutMs = 120_000): Promise<Rec> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.listeners.delete(listener);
        reject(new Error(`timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      timer.unref(); // a wait that never matches must not keep the probe alive
      const listener = (rec: Rec) => {
        if (!pred(rec)) return;
        clearTimeout(timer);
        this.listeners.delete(listener);
        resolve(rec);
      };
      this.listeners.add(listener);
    });
  }

  /** Records seen since index `from`. */
  since(from: number): Rec[] {
    return this.records.slice(from);
  }
}

const isUpdate = (rec: Rec, kind?: string): boolean => {
  const m = rec.msg as { method?: string; params?: { update?: { sessionUpdate?: string } } };
  return rec.dir === "in" && m.method === "session/update" && (kind === undefined || m.params?.update?.sessionUpdate === kind);
};

// ---------------------------------------------------------------------------
// Agent process

type Spawned = {
  child: ChildProcess;
  conn: ClientConnection;
  spawnedAt: number;
  stderr: string[];
};

function agentCommand(): { command: string; args: string[]; env: NodeJS.ProcessEnv } {
  // Like the daemon: a Claude Code session running the probe must not leak into the agent.
  const env: NodeJS.ProcessEnv = withoutHostSession(process.env);
  if (agentName === "claude") {
    const require = createRequire(import.meta.url);
    const pkg = require.resolve("@agentclientprotocol/claude-agent-acp/package.json");
    if (argv["claude-exe"]) env.CLAUDE_CODE_EXECUTABLE = argv["claude-exe"];
    return { command: process.execPath, args: [join(dirname(pkg), "dist/index.js")], env };
  }
  return { command: "opencode", args: ["acp"], env };
}

function tap(stream: Stream, rec: Recorder): Stream {
  const readable = stream.readable.pipeThrough(
    new TransformStream<AnyMessage, AnyMessage>({
      transform(msg, controller) {
        rec.push("in", msg);
        controller.enqueue(msg);
      },
    }),
  );
  const out = new TransformStream<AnyMessage, AnyMessage>({
    transform(msg, controller) {
      rec.push("out", msg);
      controller.enqueue(msg);
    },
  });
  void out.readable.pipeTo(stream.writable).catch(() => {});
  return { readable, writable: out.writable };
}

type PermissionPolicy = "allow_once" | "reject_once";

class Probe {
  rec = new Recorder();
  permissionPolicy: PermissionPolicy = "allow_once";
  current?: Spawned;
  expectingExit = false;
  unexpectedExits: { code: number | null; signal: string | null; at: number; stderrTail: string }[] = [];

  constructor(readonly cwd: string) {}

  /**
   * `path`, resolved, if it lies inside the probe directory; a request error
   * otherwise. Compares real, resolved paths, so `..` and a sibling directory
   * that shares the prefix cannot get out.
   */
  insideProbeDir(path: string): string {
    const root = realpathSync(this.cwd);
    const target = resolve(root, path);
    let real = target;
    try {
      real = realpathSync(target);
    } catch {
      // A dangling symlink would let a write land wherever it points.
      if (lstatSync(target, { throwIfNoEntry: false })?.isSymbolicLink()) {
        throw RequestError.invalidParams({ path }, "a symlink that points nowhere");
      }
      // A file about to be written: check its directory instead.
      try {
        real = join(realpathSync(dirname(target)), target.slice(dirname(target).length + 1));
      } catch {
        // Its directory does not exist either; the resolved path decides.
      }
    }
    if (real !== root && !real.startsWith(root + sep)) {
      throw RequestError.invalidParams({ path }, "outside the probe directory");
    }
    return real;
  }

  spawn(): Spawned {
    const { command, args, env } = agentCommand();
    const spawnedAt = this.rec.now();
    const child = spawn(command, args, { cwd: this.cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    const stderr: string[] = [];
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (chunk: string) => {
      stderr.push(chunk);
      if (argv.verbose) process.stderr.write(`[agent stderr] ${chunk}`);
    });
    const stream = ndJsonStream(
      Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>,
    );
    const app = client({ name: "shelly-acp-probe" })
      .onRequest("session/request_permission", ({ params }) => {
        const wanted = params.options.find((o) => o.kind === this.permissionPolicy);
        const fallback = params.options.find((o) =>
          this.permissionPolicy === "allow_once" ? o.kind.startsWith("allow") : o.kind.startsWith("reject"),
        );
        const option = wanted ?? fallback;
        if (!option) return { outcome: { outcome: "cancelled" } };
        return { outcome: { outcome: "selected", optionId: option.optionId } };
      })
      .onRequest("fs/read_text_file", ({ params }) => {
        const text = readFileSync(this.insideProbeDir(params.path), "utf8");
        if (params.line == null && params.limit == null) return { content: text };
        const lines = text.split("\n");
        const start = Math.max(0, (params.line ?? 1) - 1);
        return { content: lines.slice(start, params.limit == null ? undefined : start + params.limit).join("\n") };
      })
      .onRequest("fs/write_text_file", ({ params }) => {
        writeFileSync(this.insideProbeDir(params.path), params.content);
        return {};
      })
      .onRequest("*", ({ method }) => {
        throw RequestError.methodNotFound(method);
      })
      // Updates are read from the recorder; these only keep the SDK quiet.
      .onNotification("session/update", () => {})
      .onNotification("*", () => {});
    const conn = app.connect(tap(stream, this.rec));
    this.current = { child, conn, spawnedAt, stderr };
    // An agent that exits on its own fails its pending requests instead of
    // leaving them hanging.
    child.once("exit", (code, signal) => {
      if (this.current?.child !== child || this.expectingExit) return;
      this.unexpectedExits.push({ code, signal, at: this.rec.now(), stderrTail: stderr.join("").slice(-2000) });
      conn.close(new Error(`agent exited (code ${code}, signal ${signal})`));
    });
    return this.current;
  }

  get agent() {
    if (!this.current) throw new Error("no agent process");
    return this.current.conn.agent;
  }

  /** Every PID in the process tree under `pid`, including it. */
  static tree(pid: number): { pid: number; ppid: number; rssKb: number; comm: string }[] {
    const rows = execFileSync("ps", ["-A", "-o", "pid=,ppid=,rss=,comm="], { encoding: "utf8" })
      .trim()
      .split("\n")
      .map((line) => {
        const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
        return m ? { pid: Number(m[1]), ppid: Number(m[2]), rssKb: Number(m[3]), comm: m[4]! } : undefined;
      })
      .filter((r) => r !== undefined);
    const out = rows.filter((r) => r.pid === pid);
    for (let i = 0; i < out.length; i++) out.push(...rows.filter((r) => r.ppid === out[i]!.pid));
    return out;
  }

  static alive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  /** SIGKILLs the agent PID we spawned, then reports (and kills) any of its
   *  descendants left behind. */
  async killHard(): Promise<{ orphans: string[] }> {
    const s = this.current!;
    const descendants = Probe.tree(s.child.pid!).filter((r) => r.pid !== s.child.pid);
    this.expectingExit = true;
    s.child.kill("SIGKILL");
    await new Promise((r) => s.child.once("exit", r));
    s.conn.close();
    await sleep(1500);
    const orphans = descendants.filter((d) => Probe.alive(d.pid));
    for (const o of orphans) {
      try {
        process.kill(o.pid, "SIGKILL");
      } catch {}
    }
    this.current = undefined;
    this.expectingExit = false;
    return { orphans: orphans.map((o) => o.comm.split("/").pop()!) };
  }

  /** Closes stdin and waits for the agent to exit; SIGKILLs it after 5 s. */
  async shutdown(): Promise<void> {
    const s = this.current;
    if (!s) return;
    const descendants = Probe.tree(s.child.pid!).filter((r) => r.pid !== s.child.pid);
    this.expectingExit = true;
    const exited = s.child.exitCode !== null || s.child.signalCode !== null ? Promise.resolve() : new Promise((r) => s.child.once("exit", r));
    s.child.stdin?.end();
    const timer = setTimeout(() => s.child.kill("SIGKILL"), 5000);
    await exited;
    clearTimeout(timer);
    s.conn.close();
    // Give children a moment to notice their parent is gone.
    for (let i = 0; i < 30 && descendants.some((d) => Probe.alive(d.pid)); i++) await sleep(100);
    for (const d of descendants) {
      if (Probe.alive(d.pid)) {
        process.stderr.write(`note: descendant ${d.comm.split("/").pop()} (${d.pid}) outlived the agent by 3 s; killing it\n`);
        try {
          process.kill(d.pid, "SIGKILL");
        } catch {}
      }
    }
    this.current = undefined;
    this.expectingExit = false;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A JSON-friendly view of a thrown value (RequestError keeps code and data). */
function errInfo(error: unknown): unknown {
  if (!(error instanceof Error)) return error;
  const e = error as Error & { code?: unknown; data?: unknown };
  return { message: e.message, ...(e.code !== undefined ? { code: e.code } : {}), ...(e.data !== undefined ? { data: e.data } : {}) };
}

// ---------------------------------------------------------------------------
// Protocol steps

function clientCapabilities(): Record<string, unknown> {
  if (caps === "none") return {};
  if (caps === "shelly") {
    return { fs: { readTextFile: false, writeTextFile: false }, terminal: false, _meta: { terminal_output_delta: true } };
  }
  const fs = { readTextFile: true, writeTextFile: true };
  return { fs };
}

async function initialize(p: Probe) {
  const res = await p.agent.request("initialize", {
    protocolVersion: 1,
    clientCapabilities: clientCapabilities(),
    clientInfo: { name: "shelly-acp-probe", version: "0.0.0" },
  });
  return res;
}

function claudeMeta(persist: boolean): Record<string, unknown> {
  const options: Record<string, unknown> = { model };
  if (!persist) options.persistSession = false;
  if (lean) {
    Object.assign(options, {
      tools: [],
      settingSources: [],
      strictMcpConfig: true,
      mcpServers: {},
      extraArgs: { "disable-slash-commands": "" },
    });
  }
  return { claudeCode: { options } };
}

type SessionSetup = { sessionId: string; result: Record<string, unknown> };

async function newSession(p: Probe, opts: { persist?: boolean; mode?: string; additionalDirectories?: string[] } = {}): Promise<SessionSetup> {
  const params: Record<string, unknown> = { cwd: p.cwd, mcpServers: [] };
  if (opts.additionalDirectories) params.additionalDirectories = opts.additionalDirectories;
  if (agentName === "claude") {
    params._meta = claudeMeta(opts.persist ?? false);
    if (lean) params.systemPrompt = { mode: "override", content: [{ type: "text", text: LEAN_SYSTEM_PROMPT }] };
    // Initial config values (the unstable session-options RFD). `_meta` model
    // already starts the CLI on it; this also makes the picker report it.
    const configOptions = lean ? [] : [{ configId: "model", value: model }];
    if (opts.mode) configOptions.push({ configId: "mode", value: opts.mode });
    if (configOptions.length) params.configOptions = configOptions;
  }
  const result = (await p.agent.request("session/new", params as never)) as unknown as Record<string, unknown> & {
    sessionId: string;
  };
  if (agentName === "opencode") await selectOpencode(p, result.sessionId, result);
  return { sessionId: result.sessionId, result };
}

type ConfigOption = { id: string; currentValue?: unknown; options?: { value: string }[] | { options: { value: string }[] }[] };

/** OpenCode: pick the fast agent (lean) and the model, through whichever
 *  config option or mode the session advertised. */
async function selectOpencode(p: Probe, sessionId: string, setup: Record<string, unknown>): Promise<void> {
  const configOptions = (setup.configOptions ?? []) as ConfigOption[];
  const values = (o: ConfigOption) =>
    (o.options ?? []).flatMap((x) => ("value" in x ? [x.value] : (x as { options: { value: string }[] }).options.map((y) => y.value)));
  if (lean) {
    const modeOpt = configOptions.find((o) => o.id === "mode" || o.id === "agent");
    if (modeOpt && values(modeOpt).includes(FAST_AGENT)) {
      await p.agent.request("session/set_config_option", { sessionId, configId: modeOpt.id, value: FAST_AGENT } as never);
    } else {
      await p.agent.request("session/set_mode", { sessionId, modeId: FAST_AGENT });
    }
  }
  const modelOpt = configOptions.find((o) => o.id === "model");
  if (modelOpt && modelOpt.currentValue !== model) {
    const wanted = values(modelOpt).find((v) => v === model || v.startsWith(`${model}/`) || v.split("/").slice(0, 2).join("/") === model);
    if (!wanted) throw new Error(`model ${model} not offered; first values: ${values(modelOpt).slice(0, 10).join(", ")}`);
    await p.agent.request("session/set_config_option", { sessionId, configId: "model", value: wanted } as never);
  }
}

type TurnResult = { stopReason?: string; firstChunkMs?: number; endMs: number; text: string; error?: unknown };

async function prompt(p: Probe, sessionId: string, text: string): Promise<TurnResult> {
  const start = p.rec.now();
  const from = p.rec.records.length;
  let firstChunkMs: number | undefined;
  const first = p.rec
    .waitFor((r) => isUpdate(r, "agent_message_chunk"), 600_000)
    .then((r) => (firstChunkMs = r.t - start))
    .catch(() => {});
  try {
    const res = await p.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text }] });
    void first;
    return { stopReason: res.stopReason, firstChunkMs, endMs: p.rec.now() - start, text: agentText(p.rec.since(from)) };
  } catch (error) {
    return { firstChunkMs, endMs: p.rec.now() - start, text: agentText(p.rec.since(from)), error: errInfo(error) };
  }
}

function agentText(recs: Rec[]): string {
  return recs
    .filter((r) => isUpdate(r, "agent_message_chunk"))
    .map((r) => {
      const c = (r.msg as { params: { update: { content?: { type: string; text?: string } } } }).params.update.content;
      return c?.type === "text" ? (c.text ?? "") : "";
    })
    .join("");
}

function updateKinds(recs: Rec[]): Record<string, number> {
  const kinds: Record<string, number> = {};
  for (const r of recs) {
    const m = r.msg as { method?: string; params?: { update?: { sessionUpdate?: string } } };
    if (r.dir !== "in" || !m.method) continue;
    const key = m.method === "session/update" ? `update:${m.params?.update?.sessionUpdate}` : m.method;
    kinds[key] = (kinds[key] ?? 0) + 1;
  }
  return kinds;
}

// ---------------------------------------------------------------------------
// Probe directory

/** Sibling directories for the `external` scenario: one passed as an
 *  additional directory, one not. */
const extraDirs = { extra: "", outside: "" };

function makeExtraDirs(): void {
  for (const name of ["extra", "outside"] as const) {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), `acp-${name}-`)));
    writeFileSync(join(dir, `${name}.txt`), `First line of ${name}.txt\n`);
    extraDirs[name] = dir;
  }
}

function makeProbeDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "acp-probe-")));
  writeFileSync(join(dir, "hello.txt"), "Hello from the ACP probe.\nSecond line.\n");
  if (agentName === "opencode") {
    // Edits ask, so the permission scenarios see a request (OpenCode allows
    // everything by default). The fast agent is what `--lean` selects.
    const config = {
      $schema: "https://opencode.ai/config.json",
      // `external`: reads outside the workspace ask too.
      permission: scenarioName === "external" ? { edit: "ask", external_directory: "ask" } : { edit: "ask" },
      agent: {
        [FAST_AGENT]: {
          mode: "primary",
          description: "Shelly fast mode: no tools",
          model,
          prompt: LEAN_SYSTEM_PROMPT,
          permission: { "*": "deny" },
        },
      },
    };
    writeFileSync(join(dir, "opencode.json"), `${JSON.stringify(config, null, 2)}\n`);
  }
  return dir;
}

// ---------------------------------------------------------------------------
// Sanitizing

type Rule = { re: RegExp; to: string };

/** Replaces machine- and person-specific strings in one pass, and returns a
 *  map from each index of `s` to the matching index of the result, so that a
 *  text streamed in chunks can be scrubbed as a whole and split again. */
function scrubber(probeDir: string | undefined) {
  const home = homedir();
  const user = userInfo().username;
  const host = hostname().replace(/\.local$/, "");
  const tmp = realpathSync(tmpdir());
  const literal = (from: string, to: string): Rule[] => [
    { re: new RegExp(escape(from), "g"), to },
    ...(from.startsWith("/private/") ? [{ re: new RegExp(escape(from.slice("/private".length)), "g"), to }] : []),
  ];
  // Order matters: the first rule that matches at a position wins.
  const rules: Rule[] = [
    ...(["extra", "outside"] as const).flatMap((n) => (extraDirs[n] ? literal(extraDirs[n], `/tmp/${n}`) : [])),
    ...(probeDir ? literal(probeDir, "/tmp/probe") : []),
    ...literal(`${tmp}/`, "/tmp/"),
    ...literal(tmp, "/tmp"),
    ...literal(home, "/home/user"),
    { re: /acp-(?:probe|extra|outside)-[A-Za-z0-9]{6}/g, to: "<dir>" },
    { re: new RegExp(`\\b${escape(user)}\\b`, "gi"), to: "user" },
    { re: new RegExp(`\\b${escape(host)}\\b`, "gi"), to: "host" },
    { re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, to: "user@example.com" },
    { re: /\bsk-[A-Za-z0-9_-]{16,}/g, to: "<token>" },
    { re: /\b(?:eyJ[A-Za-z0-9_-]{10,}\.){2}[A-Za-z0-9_-]{10,}/g, to: "<token>" },
  ];
  const combined = new RegExp(rules.map((r) => `(?:${r.re.source})`).join("|"), "gi");
  const anchored = rules.map((r) => new RegExp(`^(?:${r.re.source})$`, r.re.flags.replace("g", "")));
  const replacement = (m: string): string => {
    const i = anchored.findIndex((re) => re.test(m));
    const rule = rules[i]!;
    // `acp-probe-XXXXXX` -> `probe`, and so on.
    return rule.to === "<dir>" ? m.split("-")[1]! : rule.to;
  };
  return (s: string): { out: string; map: number[] } => {
    let out = "";
    const map: number[] = [];
    let last = 0;
    for (const m of s.matchAll(combined)) {
      const at = m.index;
      for (let i = last; i < at; i++) map[i] = out.length + (i - last);
      out += s.slice(last, at);
      const rep = replacement(m[0]);
      for (let i = at; i < at + m[0].length; i++) map[i] = out.length; // inside a match: its start
      out += rep;
      last = at + m[0].length;
    }
    for (let i = last; i <= s.length; i++) map[i] = out.length + (i - last);
    out += s.slice(last);
    // A match that ends the string maps its end past the replacement.
    map[s.length] = out.length;
    return { out, map };
  };
}

const CHUNK_KINDS = new Set(["agent_message_chunk", "agent_thought_chunk", "user_message_chunk"]);

/** Scrubs streamed text as one string per message, so a path split across
 *  chunks is caught, and gives each chunk its share of the result. */
function scrubChunkStreams(records: Rec[], scrub: ReturnType<typeof scrubber>): Rec[] {
  const copy = records.map((r) => structuredClone(r));
  const groups = new Map<string, { text: { text: string } }[]>();
  for (const r of copy) {
    const m = r.msg as { method?: string; params?: { sessionId?: string; update?: { sessionUpdate?: string; messageId?: string; content?: { type?: string; text?: string } } } };
    const u = m.params?.update;
    if (m.method !== "session/update" || !u || !CHUNK_KINDS.has(u.sessionUpdate ?? "") || u.content?.type !== "text") continue;
    const key = `${r.proc ?? 1}|${m.params!.sessionId}|${u.sessionUpdate}|${u.messageId ?? ""}`;
    const list = groups.get(key) ?? [];
    list.push({ text: u.content as { text: string } });
    groups.set(key, list);
  }
  for (const list of groups.values()) {
    const joined = list.map((c) => c.text.text).join("");
    const { out, map } = scrub(joined);
    if (out === joined) continue;
    let pos = 0;
    for (const c of list) {
      const a = pos;
      const b = pos + c.text.text.length;
      pos = b;
      // Indices inside a match map to its start, so the chunk holding the
      // match's last character gets the replacement and the chunks before it
      // inside the match become empty.
      c.text.text = out.slice(map[a]!, map[b]!);
    }
  }
  return copy;
}

const TRIM_LIST = 8;

function sanitizer(probeDir: string | undefined) {
  const scrub = scrubber(probeDir);
  const str = (s: string) => scrub(s).out;
  const secretKey = /(token|secret|password|apikey|api_key|authorization|cookie|email|accountuuid|organization|orguuid|orgname|userid|displayname)/i;
  const notes: string[] = [];
  const walk = (v: unknown, key = "", path = ""): unknown => {
    if (typeof v === "string") return secretKey.test(key) && v !== "" ? "<redacted>" : str(v);
    if (Array.isArray(v)) {
      let arr = v;
      // Long lists (commands, skills, models) are trimmed: they carry the
      // user's own setup and are not part of the protocol shape.
      if ((key === "availableCommands" || key === "options" || key === "availableModels" || key === "availableModes") && v.length > TRIM_LIST) {
        notes.push(`${path}: kept ${TRIM_LIST} of ${v.length}`);
        arr = v.slice(0, TRIM_LIST);
      }
      return arr.map((x, i) => walk(x, key, `${path}[${i}]`));
    }
    if (v && typeof v === "object") {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [str(k), walk(x, k, path ? `${path}.${k}` : k)]));
    }
    return v;
  };
  const one = (rec: Rec) => {
    notes.length = 0;
    const msg = walk(rec.msg);
    const out: Record<string, unknown> = { dir: rec.dir, t: rec.t };
    if (rec.proc !== undefined) out.proc = rec.proc;
    out.msg = msg;
    if (notes.length) out.trimmed = [...notes];
    return out;
  };
  return { one, all: (records: Rec[]) => scrubChunkStreams(records, scrub).map(one) };
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function writeFixture(p: Probe, name: string): void {
  if (argv["no-record"]) return;
  const dir = join(fixtureRoot, agentName);
  mkdirSync(dir, { recursive: true });
  const lines = sanitizer(p.cwd).all(p.rec.records).map((r) => JSON.stringify(r));
  const file = join(dir, `${name}.ndjson`);
  writeFileSync(file, `${lines.join("\n")}\n`);
  report.fixture = file.replace(`${repoRoot}/`, "");
}

// ---------------------------------------------------------------------------
// Scenarios

const report: Record<string, unknown> = { agent: agentName, scenario: scenarioName, lean, caps, model };

async function setup(p: Probe, opts: { persist?: boolean; mode?: string; additionalDirectories?: string[] } = {}) {
  const s = p.spawn();
  const init = await initialize(p);
  const initMs = p.rec.now() - s.spawnedAt;
  const t0 = p.rec.now();
  const session = await newSession(p, opts);
  return { init, initMs, session, newMs: p.rec.now() - t0 };
}

const QUESTION = "What is 2+2? Answer in one word.";

const scenarios: Record<string, (p: Probe) => Promise<void>> = {
  async init(p) {
    const { init, initMs, session, newMs } = await setup(p);
    Object.assign(report, { initMs, newMs, initialize: init, sessionNew: session.result });
    await sleep(1500); // let post-setup notifications (commands, auth status) arrive
    report.updatesAfterSetup = updateKinds(p.rec.records);
  },

  async simple(p) {
    const { session, initMs, newMs } = await setup(p);
    const turn = await prompt(p, session.sessionId, QUESTION);
    Object.assign(report, { initMs, newMs, turn, updates: updateKinds(p.rec.records) });
  },

  async tool(p) {
    const { session } = await setup(p);
    const turn = await prompt(p, session.sessionId, "Read hello.txt and tell me its first line.");
    Object.assign(report, { turn, updates: updateKinds(p.rec.records), clientFsRequests: p.rec.records.filter((r) => r.dir === "in" && /^(fs|terminal)\//.test((r.msg as { method?: string }).method ?? "")).length });
  },

  async bash(p) {
    // A shell command with output on stdout and stderr and a failing exit.
    p.permissionPolicy = "allow_once";
    const { session } = await setup(p);
    const turn = await prompt(
      p,
      session.sessionId,
      "Run exactly this shell command once with your shell tool, then reply with its exit code only: printf 'one\\ntwo\\nthree\\n'; echo oops >&2; exit 3",
    );
    Object.assign(report, { turn, permissionRequests: permissionRequests(p), updates: updateKinds(p.rec.records) });
  },

  async "permission-allow"(p) {
    p.permissionPolicy = "allow_once";
    const { session } = await setup(p, { mode: agentName === "claude" ? "default" : undefined });
    const turn = await prompt(p, session.sessionId, "Create a file named allowed.txt in the current directory containing the single word hi. Do not ask me anything first.");
    Object.assign(report, { turn, permissionRequests: permissionRequests(p), fileCreated: existsSync(join(p.cwd, "allowed.txt")), updates: updateKinds(p.rec.records) });
  },

  async "permission-reject"(p) {
    p.permissionPolicy = "reject_once";
    const { session } = await setup(p, { mode: agentName === "claude" ? "default" : undefined });
    const turn = await prompt(p, session.sessionId, "Create a file named rejected.txt in the current directory containing the single word hi. Do not ask me anything first. If you are not allowed, stop and say so in one sentence.");
    Object.assign(report, { turn, permissionRequests: permissionRequests(p), fileCreated: existsSync(join(p.cwd, "rejected.txt")), updates: updateKinds(p.rec.records) });
  },

  async external(p) {
    // Manual mode for Claude, so reads outside the workspace show up as requests.
    makeExtraDirs();
    p.permissionPolicy = "allow_once";
    const { session } = await setup(p, { mode: agentName === "claude" ? "default" : undefined, additionalDirectories: [extraDirs.extra] });
    const turn = await prompt(
      p,
      session.sessionId,
      `Read ${extraDirs.extra}/extra.txt and then ${extraDirs.outside}/outside.txt with your file read tool, and reply with both first lines. Do not use shell commands.`,
    );
    Object.assign(report, { turn, permissionRequests: permissionRequests(p), updates: updateKinds(p.rec.records) });
  },

  async cancel(p) {
    const { session } = await setup(p);
    const start = p.rec.now();
    const from = p.rec.records.length;
    const pending = p.agent
      .request("session/prompt", { sessionId: session.sessionId, prompt: [{ type: "text", text: "Write the numbers from 1 to 400, one per line, and nothing else." }] })
      .then(
        (res) => ({ stopReason: res.stopReason as string | undefined, at: p.rec.now() }),
        (error: unknown) => ({ stopReason: undefined, error: errInfo(error), at: p.rec.now() }),
      );
    const chunk = await p.rec.waitFor((r) => isUpdate(r, "agent_message_chunk"));
    await sleep(300); // a few more chunks
    const cancelAt = p.rec.now();
    await p.agent.notify("session/cancel", { sessionId: session.sessionId });
    const done = await pending;
    await sleep(1500);
    const late = p.rec.records.filter((r) => r.t > done.at && isUpdate(r));
    Object.assign(report, {
      firstChunkMs: chunk.t - start,
      stopReason: done.stopReason,
      error: (done as { error?: unknown }).error,
      cancelToResponseMs: Math.round(done.at - cancelAt),
      updatesAfterResponse: late.length,
      textBeforeCancel: agentText(p.rec.since(from)).slice(0, 80),
      updates: updateKinds(p.rec.records),
    });
    // The session must still be usable.
    const after = await prompt(p, session.sessionId, QUESTION);
    report.promptAfterCancel = { stopReason: after.stopReason, text: after.text, error: after.error };
  },

  async resume(p) {
    p.rec.multiProc = true;
    // Process 1: a turn worth remembering, then a hard kill.
    const { session } = await setup(p, { persist: true });
    const sessionId = session.sessionId;
    const first = await prompt(p, sessionId, "Remember the codeword PELICAN. Reply with just OK.");
    const killed = await p.killHard();
    report.turn1 = { stopReason: first.stopReason, text: first.text };
    report.afterKill = killed;

    // Process 2: session/load.
    p.rec.proc = 2;
    const s2 = p.spawn();
    const init2 = await initialize(p);
    const caps2 = (init2 as { agentCapabilities?: { loadSession?: boolean; sessionCapabilities?: Record<string, unknown> } }).agentCapabilities;
    report.loadSession = caps2?.loadSession;
    report.sessionCapabilities = caps2?.sessionCapabilities;
    report.initMs2 = p.rec.now() - s2.spawnedAt;
    let from = p.rec.records.length;
    let t0 = p.rec.now();
    try {
      await p.agent.request("session/load", { sessionId, cwd: p.cwd, mcpServers: [], ...(agentName === "claude" ? { _meta: claudeMeta(true) } : {}) } as never);
      report.load = { ms: p.rec.now() - t0, replayed: updateKinds(p.rec.since(from)) };
      const t2 = await prompt(p, sessionId, "What was the codeword? One word.");
      report.load = { ...(report.load as object), recall: t2.text, stopReason: t2.stopReason, error: t2.error };
    } catch (error) {
      report.load = { ms: p.rec.now() - t0, error: errInfo(error) };
    }
    await p.killHard();

    // Process 3: session/resume.
    p.rec.proc = 3;
    p.spawn();
    await initialize(p);
    from = p.rec.records.length;
    t0 = p.rec.now();
    try {
      await p.agent.request("session/resume", { sessionId, cwd: p.cwd, mcpServers: [], ...(agentName === "claude" ? { _meta: claudeMeta(true) } : {}) } as never);
      report.resume = { ms: p.rec.now() - t0, replayed: updateKinds(p.rec.since(from)) };
      const t3 = await prompt(p, sessionId, "Repeat the codeword once more. One word.");
      report.resume = { ...(report.resume as object), recall: t3.text, stopReason: t3.stopReason, error: t3.error };
    } catch (error) {
      report.resume = { ms: p.rec.now() - t0, error: errInfo(error) };
    }
    try {
      const t4 = p.rec.now();
      await p.agent.request("session/close", { sessionId } as never);
      report.closeMs = p.rec.now() - t4;
    } catch (error) {
      report.close = { error: errInfo(error) };
    }
    report.sessionId = sessionId;
  },

  async latency(p) {
    const runs = Number(argv.runs ?? "3");
    const rows: Record<string, number | undefined>[] = [];
    for (let i = 0; i < runs; i++) {
      p.rec = new Recorder();
      const { session, initMs, newMs } = await setup(p);
      const a = await prompt(p, session.sessionId, QUESTION);
      const b = await prompt(p, session.sessionId, "And 3+3? One word.");
      rows.push({ initMs, newMs, firstChunkMs: a.firstChunkMs, endMs: a.endMs, secondFirstChunkMs: b.firstChunkMs, secondEndMs: b.endMs });
      if (a.error || b.error) report.errors = [a.error, b.error];
      await p.shutdown();
    }
    const median = (k: string) => {
      const xs = rows.map((r) => r[k]).filter((x): x is number => typeof x === "number").sort((x, y) => x - y);
      return xs.length ? Math.round(xs[Math.floor(xs.length / 2)]!) : undefined;
    };
    report.runs = rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v === undefined ? v : Math.round(v)])));
    report.median = Object.fromEntries(Object.keys(rows[0] ?? {}).map((k) => [k, median(k)]));
  },

  async rss(p) {
    const s = p.spawn();
    await initialize(p);
    const pid = s.child.pid!;
    const snap = (label: string) => {
      const tree = Probe.tree(pid);
      return { label, totalMb: Math.round(tree.reduce((a, r) => a + r.rssKb, 0) / 1024), procs: tree.map((r) => ({ comm: r.comm.split("/").pop(), mb: Math.round(r.rssKb / 1024) })) };
    };
    await sleep(2000);
    const snaps = [snap("after initialize")];
    const a = await newSession(p);
    await prompt(p, a.sessionId, QUESTION);
    await sleep(4000);
    snaps.push(snap("1 session, idle after one turn"));
    const b = await newSession(p);
    await sleep(4000);
    snaps.push(snap("2 sessions, second never prompted"));
    try {
      await p.agent.request("session/close", { sessionId: b.sessionId } as never);
      await sleep(3000);
      snaps.push(snap("after session/close of the second"));
    } catch (error) {
      snaps.push({ label: `session/close failed: ${String((error as Error).message)}`, totalMb: 0, procs: [] });
    }
    report.snapshots = snaps;
    // Network sockets of the tree: shows whether the agent talks to a shared
    // background service (OpenCode) or only to the model API.
    try {
      const pids = Probe.tree(pid).map((r) => r.pid).join(",");
      const lsof = execFileSync("lsof", ["-a", "-p", pids, "-i", "-n", "-P"], { encoding: "utf8" });
      report.sockets = lsof.trim().split("\n").slice(1).map((l) => l.split(/\s+/).slice(7).join(" "));
    } catch {
      report.sockets = [];
    }
  },
};

function permissionRequests(p: Probe) {
  return p.rec.records
    .filter((r) => r.dir === "in" && (r.msg as { method?: string }).method === "session/request_permission")
    .map((r) => (r.msg as { params: unknown }).params);
}

// ---------------------------------------------------------------------------
// Main

/** `--resanitize`: runs the current sanitizer over every recorded fixture
 *  again, for when a rule is added after recording. */
function resanitize(): void {
  for (const agent of ["claude", "opencode"]) {
    const dir = join(fixtureRoot, agent);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir).filter((f) => f.endsWith(".ndjson"))) {
      const file = join(dir, name);
      const rows = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Rec & { trimmed?: string[] });
      const clean = sanitizer(undefined).all(rows);
      const lines = clean.map((r, i) => JSON.stringify(rows[i]!.trimmed && !r.trimmed ? { ...r, trimmed: rows[i]!.trimmed } : r));
      writeFileSync(file, `${lines.join("\n")}\n`);
    }
  }
}

async function main(): Promise<void> {
  if (argv.resanitize) return resanitize();
  if (agentName !== "claude" && agentName !== "opencode") throw new Error("--agent must be claude or opencode");
  const run = scenarios[scenarioName];
  if (!run) throw new Error(`--scenario must be one of: ${Object.keys(scenarios).join(", ")}`);
  if (!["fs", "none", "shelly"].includes(caps)) throw new Error("--caps must be fs, none or shelly");
  const dir = makeProbeDir();
  const p = new Probe(dir);
  let failed: unknown;
  try {
    await run(p);
  } catch (error) {
    failed = error;
  } finally {
    await p.shutdown().catch(() => {});
  }
  // A failed run keeps the checked-in fixture; its recording is not one.
  if (!failed && scenarioName !== "latency" && scenarioName !== "rss") {
    const suffix = [lean ? "lean" : "", caps !== "fs" ? `caps-${caps}` : ""].filter(Boolean).join("-");
    writeFixture(p, suffix ? `${scenarioName}-${suffix}` : scenarioName);
  }
  if (p.unexpectedExits.length) report.unexpectedExits = p.unexpectedExits;
  if (!argv.keep) {
    rmSync(dir, { recursive: true, force: true });
    for (const d of Object.values(extraDirs)) if (d) rmSync(d, { recursive: true, force: true });
  }
  else report.probeDir = dir;
  const out = sanitizer(dir).one({ dir: "in", t: 0, msg: report as unknown as AnyMessage }).msg as Record<string, unknown>;
  if (failed) out.failed = errInfo(failed);
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  if (failed) process.exitCode = 1;
}

await main();
