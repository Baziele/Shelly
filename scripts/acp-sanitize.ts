/**
 * Sanitizes recorded ACP traffic before it becomes a fixture: machine- and
 * person-specific paths and names, emails, tokens and secret-looking keys.
 * Shared by scripts/acp-probe.ts and scripts/acp-record.ts.
 *
 * Streamed text is scrubbed per message (a path split across chunks is still
 * caught), and ACP v2 terminal output, which is base64, is decoded, scrubbed
 * and encoded again.
 */
import { realpathSync } from "node:fs";
import { homedir, hostname, tmpdir, userInfo } from "node:os";

export type Rec = { dir: "in" | "out"; t: number; msg: unknown; proc?: number; trimmed?: string[] };

type Rule = { re: RegExp; to: string };

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Replaces machine- and person-specific strings in one pass, and returns a
 *  map from each index of `s` to the matching index of the result, so that a
 *  text streamed in chunks can be scrubbed as a whole and split again.
 *  `dirs` are recording directories, most specific first, with what each
 *  becomes (`/tmp/probe`, …). */
function scrubber(dirs: ReadonlyArray<readonly [string, string]>) {
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
    ...dirs.flatMap(([from, to]) => literal(from, to)),
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

/** ACP v2 terminal output is base64: scrub what it decodes to. */
function scrubTerminalOutput(records: Rec[], str: (s: string) => string): void {
  const recode = (data: unknown): unknown =>
    typeof data === "string" ? Buffer.from(str(Buffer.from(data, "base64").toString("utf8")), "utf8").toString("base64") : data;
  for (const r of records) {
    const m = r.msg as { method?: string; params?: { update?: { sessionUpdate?: string; data?: unknown; output?: { data?: unknown } } } };
    const u = m.params?.update;
    if (m.method !== "session/update" || !u) continue;
    if (u.sessionUpdate === "terminal_output_chunk") u.data = recode(u.data);
    if (u.sessionUpdate === "terminal_update" && u.output) u.output.data = recode(u.output.data);
  }
}

const TRIM_LIST = 8;

export function sanitizer(dirs: ReadonlyArray<readonly [string, string]>) {
  const scrub = scrubber(dirs);
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
  const all = (records: Rec[]) => {
    const copy = scrubChunkStreams(records, scrub);
    scrubTerminalOutput(copy, str);
    return copy.map(one);
  };
  return { one, all };
}
