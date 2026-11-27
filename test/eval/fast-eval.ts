import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as ManagedRuntime from 'effect/ManagedRuntime';
import * as Stream from 'effect/Stream';
import type { ContextCommand, FastInput } from '../../src/protocol/schema.js';
import { FastService, ShellyConfig } from '../../src/daemon/services.js';
import * as Fast from '../../src/daemon/fast/fast-service.js';

/*
 * Real requests to the user's Claude Code through FastService, to judge the
 * prompt and measure latency. Each case costs a model call:
 *
 *   node --import tsx test/eval/fast-eval.ts [case-name …]
 */

const mac = { os: 'macOS 25.2.0 (arm64)', shell: 'zsh', shellVersion: 'zsh 5.9 (arm64-apple-darwin25.0)', terminal: null };
const linux = { os: 'Linux 6.8.0 (x64)', shell: 'bash', shellVersion: 'GNU bash, version 5.2.21(1)-release', terminal: null };
const fish = { os: 'macOS 25.2.0 (arm64)', shell: 'fish', shellVersion: 'fish, version 3.7.1', terminal: null };

const ran = (command: string, exitCode: number, output: string): ContextCommand => ({
  id: 1, command, cwd: '/Users/me/app', exitCode, durationMs: 800, output, omittedLines: 0, usedFullScreen: false,
});

interface Case {
  readonly name: string;
  readonly input: Partial<FastInput> & { readonly instruction: string };
  /** What a good reply looks like, for the reader. */
  readonly expect: string;
  /** Continue the conversation of this earlier case. */
  readonly session?: string;
}

const CASES: readonly Case[] = [
  { name: 'big-files', input: { instruction: 'find files bigger than 500MB in my home folder' }, expect: 'find ~ -type f -size +500M' },
  { name: 'free-port', input: { instruction: 'kill whatever is using port 8080' }, expect: 'lsof -ti tcp:8080 | xargs kill' },
  { name: 'git-undo', input: { instruction: 'undo my last commit but keep the changes' }, expect: 'git reset --soft HEAD~1' },
  { name: 'compress', input: { instruction: 'compress the photos folder into a zip' }, expect: 'zip -r photos.zip photos' },
  { name: 'tail-filter', input: { instruction: 'follow app.log and only show lines with ERROR' }, expect: 'tail -f app.log | grep --line-buffered ERROR' },
  { name: 'docker-clean', input: { instruction: 'remove stopped docker containers and dangling images' }, expect: 'docker container prune -f && docker image prune -f' },
  { name: 'rw-recursive', input: { instruction: 'make it recursive', buffer: 'grep -n "TODO" src/*.ts' }, expect: 'grep -rn "TODO" src --include="*.ts"' },
  { name: 'rw-followup', session: 'rw-recursive', input: { instruction: 'now just count the matches in each file', buffer: '' }, expect: 'grep -rc "TODO" src --include="*.ts"' },
  { name: 'rw-dry-run', input: { instruction: 'add a dry run', buffer: 'rsync -av --delete ./site/ deploy@example.com:/var/www/site/' }, expect: 'rsync -avn --delete … (or --dry-run)' },
  { name: 'rw-xargs', input: { instruction: 'convert to xargs', buffer: "find . -name '*.log' -mtime +7 -exec rm {} \\;" }, expect: "find . -name '*.log' -mtime +7 -print0 | xargs -0 rm" },
  {
    name: 'fix-push',
    input: {
      instruction: 'fix that',
      recentCommands: [ran('git push', 128, 'fatal: The current branch feature/login has no upstream branch.\nTo push the current branch and set the remote as upstream, use\n\n    git push --set-upstream origin feature/login\n')],
    },
    expect: 'git push --set-upstream origin feature/login',
  },
  {
    name: 'fix-typo',
    input: {
      instruction: 'fix that',
      recentCommands: [
        ran('cd ~/app', 0, ''),
        ran('npm run biuld', 1, 'npm error Missing script: "biuld"\nnpm error\nnpm error Did you mean this?\nnpm error   npm run build # run the "build" package script\n'),
      ],
    },
    expect: 'npm run build',
  },
  { name: 'q-print0', input: { instruction: 'what does -print0 do in find?' }, expect: '# answer, ≤3 lines' },
  { name: 'q-fetch-pull', input: { instruction: "what's the difference between git fetch and git pull?" }, expect: '# answer, ≤3 lines' },
  { name: 'linux-mem', input: { instruction: 'which processes use the most memory', environment: linux }, expect: 'ps aux --sort=-%mem | head (GNU)' },
  { name: 'fish-env', input: { instruction: 'set FOO to bar for this shell and its children', environment: fish }, expect: 'set -gx FOO bar' },
];

const inputFor = (c: Case): FastInput => ({
  buffer: '',
  cwd: '/Users/me/app',
  environment: mac,
  recentCommands: [],
  ...c.input,
});

const rssOfGroup = (): number => {
  // Every claude process this script started, with any children, by process group.
  const out = execFileSync('ps', ['-A', '-o', 'pgid=,rss=,ppid=,pid='], { encoding: 'utf8' });
  const ours = new Set(out.trim().split('\n').map((line) => line.trim().split(/\s+/).map(Number))
    .filter(([, , ppid]) => ppid === process.pid).map(([, , , pid]) => pid));
  return out.trim().split('\n').map((line) => line.trim().split(/\s+/).map(Number))
    .filter(([pgid]) => ours.has(pgid!)).reduce((sum, [, rss]) => sum + rss!, 0);
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const main = async () => {
  const only = new Set(process.argv.slice(2));
  const cases = CASES.filter((c) => only.size === 0 || only.has(c.name));
  const home = mkdtempSync(join(tmpdir(), 'shelly-eval-'));
  const runtime = ManagedRuntime.make(Fast.layer.pipe(Layer.provide(Layer.mergeAll(
    Layer.succeed(ShellyConfig, ShellyConfig.of({ get: Effect.succeed({}), setDefaultAgent: () => Effect.void })),
    Layer.succeed(Fast.FastSettings, { ...Fast.fastSettingsFromEnv(process.env), fastHome: join(home, 'fast') }),
  ))));
  const service = await runtime.runPromise(FastService.use(Effect.succeed));
  const rows: string[] = [];

  try {
    for (const [index, c] of cases.entries()) {
      const cold = index === 0 && !only.has('warm');
      if (!cold && !c.session) {
        await runtime.runPromise(service.prewarm('claude'));
        await sleep(4000);
      }
      if (index === 1) console.error(`idle warm worker RSS: ${Math.round(rssOfGroup() / 1024)} MB across ${await runtime.runPromise(service.workerCount)} workers`);
      const started = performance.now();
      let first: number | null = null;
      const events = await runtime.runPromise(Stream.runCollect(
        service.request({ agentId: 'claude', sessionKey: c.session ?? c.name, input: inputFor(c) }).pipe(
          Stream.tap((event) => Effect.sync(() => {
            if (event.type === 'delta' && first === null) first = performance.now() - started;
          })),
        ),
      ).pipe(Effect.catch((error) => Effect.succeed([{ type: 'error', text: String(error) }] as const))));
      const total = Math.round(performance.now() - started);
      const done = events.at(-1)!;
      const raw = events.filter((event) => event.type === 'delta').map((event) => event.text).join('');
      const text = 'text' in done ? done.text : '';
      const kind = done.type === 'done' ? done.kind : 'error';
      rows.push(`| ${c.name} | ${cold ? 'cold' : c.session ? 'session' : 'warm'} | ${first === null ? '–' : Math.round(first)} | ${total} | ${kind} | \`${text.replaceAll('\n', '⏎').replaceAll('|', '\\|')}\` |`);
      console.error(`${c.name}: ${first === null ? '-' : Math.round(first)} / ${total} ms  ${kind}\n  got:    ${JSON.stringify(text)}\n  raw:    ${JSON.stringify(raw)}\n  expect: ${c.expect}`);
    }
    console.error(`steady state: ${await runtime.runPromise(service.workerCount)} workers, ${Math.round(rssOfGroup() / 1024)} MB`);
  } finally {
    await runtime.dispose();
    rmSync(home, { recursive: true, force: true });
  }
  console.log('| case | start | first delta ms | done ms | kind | reply |\n|---|---|---|---|---|---|');
  console.log(rows.join('\n'));
};

await main();
