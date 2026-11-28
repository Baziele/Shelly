import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { crashGuard, STORM } from './crash-guard.js';

const fakes = () => {
  let now = 0;
  const steps: string[] = [];
  const logged: string[] = [];
  let written = '';
  const guard = crashGuard({
    restoreTerminal: () => steps.push('restore'),
    killShell: () => steps.push('kill'),
    log: (what) => logged.push(what),
    logPath: '/home/u/.shelly/logs/client.log',
    write: (text) => {
      steps.push('write');
      written += text;
    },
    exit: (code) => steps.push(`exit ${code}`),
    now: () => now,
  });
  return { guard, steps, logged, written: () => written, advance: (ms: number) => (now += ms) };
};

describe('crashGuard', () => {
  it('ends Shelly on an uncaught exception: the terminal restored, the shell ended, the log named', () => {
    const t = fakes();
    t.guard.uncaughtException(new Error('pty write failed\n  at somewhere'));
    assert.deepEqual(t.logged, ['uncaught exception']);
    assert.deepEqual(t.steps, ['restore', 'kill', 'write', 'exit 1']);
    assert.ok(t.written().startsWith('\u001b[0m\u001b[?25h'), 'attributes reset, cursor shown');
    assert.match(t.written(), /shelly crashed: pty write failed\r\n/);
    assert.match(t.written(), /\/home\/u\/\.shelly\/logs\/client\.log/);
  });

  it('carries on after unhandled rejections, logging each, until a storm of them', () => {
    const t = fakes();
    for (let i = 1; i < STORM.errors; i++) {
      t.guard.unhandledRejection(new Error(`lost ${i}`));
      t.advance(1000);
    }
    assert.equal(t.logged.length, STORM.errors - 1);
    assert.deepEqual(t.steps, [], 'still running');
    t.guard.unhandledRejection(new Error('one too many'));
    assert.deepEqual(t.steps, ['restore', 'kill', 'write', 'exit 1']);
    assert.match(t.written(), /one too many/);
  });

  it('never counts rejections spread out over time as a storm', () => {
    const t = fakes();
    for (let i = 0; i < STORM.errors * 3; i++) {
      t.guard.unhandledRejection('lost');
      t.advance(STORM.withinMs / (STORM.errors - 1) + 1);
    }
    assert.deepEqual(t.steps, []);
  });

  it('crashes once, and still exits when restoring the terminal throws', () => {
    const steps: string[] = [];
    const guard = crashGuard({
      restoreTerminal: () => {
        throw new Error('EIO');
      },
      killShell: () => steps.push('kill'),
      log: () => undefined,
      logPath: 'log',
      write: () => undefined,
      exit: (code) => steps.push(`exit ${code}`),
    });
    guard.uncaughtException(new Error('a'));
    guard.uncaughtException(new Error('b'));
    assert.deepEqual(steps, ['kill', 'exit 1']);
  });
});
