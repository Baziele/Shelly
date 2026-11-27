import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CommandLog } from './command-log.js';
import type { EnvironmentInfo } from './environment.js';
import { buildAgentContext, buildAskContext, formatAskContext } from './session-context.js';

const ENVIRONMENT: EnvironmentInfo = { os: 'macOS 25.0 (arm64)', shell: 'zsh', shellVersion: 'zsh 5.9', terminal: 'Ghostty' };

const createLog = (): CommandLog => {
  let clock = 0;
  const log = new CommandLog({ columns: () => 80, now: () => (clock += 1200) });
  log.handle({ type: 'cwd', path: '/repo' });
  return log;
};

const run = (log: CommandLog, command: string, output: string, exitCode = 0): void => {
  log.handle({ type: 'exec', command });
  log.recordOutput(output);
  log.handle({ type: 'done', exitCode });
};

const numberedLines = (count: number): string =>
  Array.from({ length: count }, (_, index) => `line ${index + 1}`).join('\r\n');

describe('buildAskContext', () => {
  it('includes recent commands in full when they fit', async () => {
    const log = createLog();
    run(log, 'git status', 'nothing to commit\r\n');
    run(log, 'npm test', 'FAIL a.test.ts\r\n', 1);

    const context = await buildAskContext(log, ENVIRONMENT);
    assert.equal(context.cwd, '/repo');
    assert.deepEqual(context.commands.map((command) => [command.command, command.exitCode, command.output]), [
      ['git status', 0, 'nothing to commit'],
      ['npm test', 1, 'FAIL a.test.ts'],
    ]);
  });

  it('keeps the end of long output and gives the newest commands priority', async () => {
    const log = createLog();
    run(log, 'old', numberedLines(500));
    run(log, 'new', numberedLines(500));

    const context = await buildAskContext(log, ENVIRONMENT, { maxOutputChars: 100, maxTotalChars: 150 });
    const [old, latest] = context.commands;
    assert.ok(latest?.output.endsWith('line 500'));
    assert.ok((latest?.output.length ?? 0) <= 100);
    assert.ok((latest?.omittedLines ?? 0) > 0);
    assert.ok((old?.output.length ?? 0) <= 50, 'the older command gets what is left');
  });
});

describe('buildAskContext with one long line', () => {
  it('keeps the end of a line too long to fit whole', async () => {
    const log = createLog();
    run(log, 'curl api', `{"items":[${'1,'.repeat(5000)}"end"]}`);
    const [command] = (await buildAskContext(log, ENVIRONMENT, { maxOutputChars: 100 })).commands;
    assert.equal(command?.output.length, 100);
    assert.ok(command?.output.startsWith('…'));
    assert.ok(command?.output.endsWith('"end"]}'));
  });
});

describe('formatAskContext', () => {
  it('renders the environment and each command', async () => {
    const log = createLog();
    run(log, 'ls', 'a\r\nb\r\n');
    const text = formatAskContext(await buildAskContext(log, ENVIRONMENT));
    assert.equal(
      text,
      [
        'OS: macOS 25.0 (arm64)',
        'Shell: zsh 5.9',
        'Terminal: Ghostty',
        'Working directory: /repo',
        '',
        '$ ls',
        '  [exit 0 · 1.2s · /repo]',
        '  a',
        '  b',
      ].join('\n'),
    );
  });
});

describe('buildAgentContext', () => {
  it('summarises commands and reads output on demand', async () => {
    const log = createLog();
    run(log, 'make', numberedLines(300), 2);

    const context = await buildAgentContext(log, ENVIRONMENT);
    assert.deepEqual(context.commands.map((command) => [command.id, command.command, command.exitCode, command.outputLines]), [
      [1, 'make', 2, 300],
    ]);

    const tail = await context.readOutput(1, { maxLines: 2 });
    assert.deepEqual(tail, { id: 1, startLine: 299, lines: ['line 299', 'line 300'], totalLines: 300 });

    const start = await context.readOutput(1, { startLine: 1, maxLines: 1 });
    assert.deepEqual(start?.lines, ['line 1']);
    assert.equal(await context.readOutput(42), undefined);
  });
});
