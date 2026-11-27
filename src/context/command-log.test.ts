import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CommandLog, type CommandLogOptions } from './command-log.js';

const createLog = (options: Partial<CommandLogOptions> = {}): CommandLog => {
  let clock = 1000;
  return new CommandLog({ columns: () => 80, now: () => (clock += 250), ...options });
};

const run = (log: CommandLog, command: string, output: string, exitCode = 0): void => {
  log.handle({ type: 'exec', command });
  log.recordOutput(output);
  log.handle({ type: 'done', exitCode });
};

describe('CommandLog', () => {
  it('records each command with its cleaned output, exit status and directory', async () => {
    const log = createLog();
    log.handle({ type: 'cwd', path: '/repo' });
    run(log, 'npm test', '\u001b[31mFAIL\u001b[0m src/a.test.ts\r\n', 1);

    const [record] = await log.recent();
    assert.deepEqual(record, {
      id: 1,
      command: 'npm test',
      cwd: '/repo',
      startedAt: 1250,
      finishedAt: 1500,
      exitCode: 1,
      usedFullScreen: false,
      output: 'FAIL src/a.test.ts',
    });
  });

  it('ignores output between commands, such as the prompt', async () => {
    const log = createLog();
    log.recordOutput('$ ');
    run(log, 'echo hi', 'hi\r\n');
    log.recordOutput('$ ');
    assert.equal((await log.recent())[0]?.output, 'hi');
  });

  it('keeps commands typed with a leading space, or left unnamed, out of the log', async () => {
    const log = createLog();
    run(log, ' export TOKEN=abc', '');
    run(log, '', 'secret output\r\n');
    run(log, 'ls', 'file\r\n');
    assert.deepEqual((await log.recent()).map((record) => record.command), ['ls']);
  });

  it('ignores a prompt that follows no command, as after an empty line', async () => {
    const log = createLog();
    log.handle({ type: 'done', exitCode: 0 });
    assert.deepEqual(await log.recent(), []);
  });

  it('masks secrets in commands and output', async () => {
    const log = createLog();
    run(log, 'export API_KEY=sk-abcdefghijklmnopqrstuvwxyz', 'token=ghp_abcdefghijklmnopqrstuvwxyz0123456789\r\n');
    const [record] = await log.recent();
    assert.equal(record?.command, 'export API_KEY=[redacted]');
    assert.equal(record?.output, 'token=[redacted]');
  });

  it('cleans up output off the output path, once, and only waits when asked', async () => {
    let renders = 0;
    const log = createLog({
      render: async (snapshot) => {
        renders++;
        return snapshot.head.trim();
      },
    });
    run(log, 'make', 'built\r\n');
    assert.equal(renders, 0, 'nothing happens while the command output is being forwarded');

    assert.equal((await log.recent())[0]?.output, 'built');
    await log.recent();
    assert.equal(renders, 1);
  });

  it('drops the oldest commands past its limits', async () => {
    const log = createLog({ maxCommands: 2 });
    run(log, 'one', '');
    run(log, 'two', '');
    run(log, 'three', '');
    assert.deepEqual((await log.recent()).map((record) => record.command), ['two', 'three']);

    const small = createLog({ maxStoredChars: 10 });
    run(small, 'big', 'x'.repeat(8));
    run(small, 'bigger', 'y'.repeat(8));
    assert.deepEqual((await small.recent()).map((record) => record.command), ['bigger']);
  });

  it('closes a command whose end was never reported when the next one starts', async () => {
    const log = createLog();
    log.handle({ type: 'exec', command: 'zsh' });
    log.recordOutput('nested\r\n');
    run(log, 'ls', 'file\r\n');
    const records = await log.recent();
    assert.deepEqual(records.map((record) => [record.command, record.exitCode]), [['zsh', undefined], ['ls', 0]]);
  });

  it('finds a command by id', async () => {
    const log = createLog();
    run(log, 'one', 'first\r\n');
    run(log, 'two', 'second\r\n');
    assert.equal((await log.find(2))?.output, 'second');
    assert.equal(await log.find(9), undefined);
  });
});
