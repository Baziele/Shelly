import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { after, describe, it } from 'node:test';
import type { DaemonLink } from './client/daemon-link.js';
import type { ReleaseOptions } from './client/flow-host.js';
import type { ShellSessionOptions } from './shell/shell-session.js';
import type { HostTerminal } from './terminal/host-terminal.js';

/*
 * The hand-over between Shelly and the shell, with a fake terminal and a
 * fake shell: Shelly draws (busy), gives the prompt back (returning), and
 * the shell has its line again. The user is never locked out.
 */

process.env.SHELLY_BUSY_WATCHDOG_MS = '200';
process.env.SHELLY_PROMPT_WAIT_MS = '300';
const { Shelly, printableOnly } = await import('./shelly.js');

const home = mkdtempSync(join(tmpdir(), 'shelly-unit-'));
after(() => rmSync(home, { recursive: true, force: true }));

interface Internals {
  mode: string;
  claim(onKeys: (data: string) => boolean): void;
  release(options: ReleaseOptions): void;
}

const setup = () => {
  let onInput: (data: string) => void = () => undefined;
  let written = '';
  const host = {
    size: { cols: 80, rows: 24 },
    start: (listener: (data: string) => void) => (onInput = listener),
    stop: () => undefined,
    onResize: () => () => undefined,
    write: (data: string) => (written += data),
    queryCursorPosition: () => Promise.resolve({ row: 5, col: 3 }),
  } as unknown as HostTerminal;

  const toShell: string[] = [];
  let shellOutput: (data: string) => void = () => undefined;
  let exit: (code: number) => void = () => undefined;
  let nonce = '';
  const spawnShell = (options: ShellSessionOptions) => {
    nonce = String(options.env.SHELLY_NONCE ?? '');
    return {
      onData: (listener: (data: string) => void) => (shellOutput = listener),
      onExit: (listener: (code: number) => void) => (exit = listener),
      write: (data: string) => toShell.push(data),
      resize: () => undefined,
      kill: () => exit(0),
      isShellInForeground: () => true,
    };
  };
  const link = {
    startDaemon: () => Promise.reject(new Error('no daemon here')),
    get: () => Promise.reject(new Error('no daemon here')),
    dispose: () => Promise.resolve(),
    loaded: undefined,
    lastError: undefined,
  } as unknown as DaemonLink;

  const shelly = new Shelly({ host, shell: '/bin/zsh', cwd: home, env: { HOME: home, PATH: process.env.PATH ?? '' }, link, spawnShell });
  const running = shelly.run();
  const internals = shelly as unknown as Internals;
  const marker = (kind: string, payload: string) => `\u001b]6973;${nonce};${kind};${payload}\u0007`;
  /** The shell draws a prompt, as its hooks report it. */
  const prompt = () => shellOutput(`${marker('cwd', encodeURIComponent(home))}$ `);
  return {
    internals,
    written: () => written,
    toShell,
    type: (data: string) => onInput(data),
    shellOutput: (data: string) => shellOutput(data),
    prompt,
    stop: async () => {
      shelly.terminate();
      await running;
    },
  };
};

const freshLine: ReleaseOptions = { cursor: 'fresh-line', line: { type: 'as-before' } };

describe('Shelly hands the terminal back', () => {
  it('gives the prompt back on its own when busy with nothing drawing (an error lost on the way)', async () => {
    const t = setup();
    t.prompt();
    t.internals.claim(() => false);
    t.type('ls');
    assert.equal(t.internals.mode, 'busy');
    await sleep(350);
    assert.match(t.written(), /Shelly lost its place; your prompt is back/);
    assert.ok(t.toShell.includes('\r'), 'the shell was asked for a new prompt');
    t.prompt();
    await sleep(20);
    assert.equal(t.internals.mode, 'shell');
    assert.ok(t.toShell.includes('ls'), 'what was typed reaches the shell');
    await t.stop();
  });

  it('carries on after the prompt wait, replaying only printable text', async () => {
    const t = setup();
    t.prompt();
    t.internals.claim(() => false);
    t.type('ls\u001b[A -la\r');
    t.internals.release(freshLine);
    assert.equal(t.internals.mode, 'returning');
    // The shell never reports its prompt.
    await sleep(400);
    assert.equal(t.internals.mode, 'shell');
    assert.ok(t.toShell.includes('ls -la'), JSON.stringify(t.toShell));
    assert.ok(!t.toShell.some((data) => data.includes('\u001b[A') || data.endsWith('ls -la\r')), 'no stale arrow or Enter');
    await t.stop();
  });

  it('drops what the idle shell drew meanwhile, and what it writes before the new prompt', async () => {
    const t = setup();
    t.prompt();
    t.internals.claim(() => false);
    t.shellOutput('\u001b[2A$ REPAINT');
    t.internals.release(freshLine);
    t.shellOutput('\r\nLATE-REPAINT');
    t.prompt();
    await sleep(20);
    assert.ok(!t.written().includes('REPAINT'), JSON.stringify(t.written()));
    assert.ok(t.written().endsWith('$ '), 'the new prompt is drawn');
    assert.equal(t.internals.mode, 'shell');
    await t.stop();
  });

  it('sends Ctrl-C on at once while the prompt comes back, never later', async () => {
    const t = setup();
    t.prompt();
    t.internals.claim(() => false);
    t.internals.release(freshLine);
    t.type('\u0003x\u0004');
    assert.equal(t.toShell.at(-1), '\u0003', 'Ctrl-C at once');
    t.prompt();
    await sleep(20);
    assert.equal(t.toShell.filter((data) => data.includes('\u0003')).length, 1, 'and never again');
    assert.equal(t.toShell.at(-1), 'x');
    assert.ok(!t.toShell.some((data) => data.includes('\u0004')), 'Ctrl-D dropped');
    await t.stop();
  });

  it('ignores a second release, so an error path cannot draw another prompt', async () => {
    const t = setup();
    t.prompt();
    t.internals.claim(() => false);
    t.internals.release(freshLine);
    t.internals.release(freshLine);
    assert.equal(t.toShell.filter((data) => data === '\r').length, 1);
    await t.stop();
  });
});

describe('printableOnly', () => {
  it('keeps text, drops keys and escape sequences', () => {
    assert.equal(printableOnly('git st\u001b[Datus\r\u0003\u001bOA ok'), 'git status ok');
  });
});
