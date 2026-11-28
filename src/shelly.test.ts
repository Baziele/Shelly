import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { after, describe, it } from 'node:test';
import type { DaemonLink } from './client/daemon-link.js';
import type { ReleaseOptions } from './client/flow-host.js';
import type { ShellSessionOptions } from './shell/shell-session.js';
import { LINE_KEYS } from './shell/line-editor.js';
import type { HostTerminal } from './terminal/host-terminal.js';

/*
 * The hand-over between Shelly and the shell, with a fake terminal and a
 * fake shell: Shelly draws (busy), gives the prompt back (returning), and
 * the shell has its line again. The user is never locked out.
 */

process.env.SHELLY_BUSY_WATCHDOG_MS = '200';
process.env.SHELLY_PROMPT_WAIT_MS = '300';
const { Shelly, printableOnly, withoutDrawing } = await import('./shelly.js');

const home = mkdtempSync(join(tmpdir(), 'shelly-unit-'));
after(() => rmSync(home, { recursive: true, force: true }));

interface Internals {
  mode: string;
  claim(onKeys: (data: string) => boolean): void;
  release(options: ReleaseOptions): void;
}

interface SetupOptions {
  /** Where the terminal says the cursor is, asked each time. */
  readonly cursor?: () => Promise<{ row: number; col: number }>;
  /** Called with each write to the shell, after it is recorded. */
  readonly onShellWrite?: (data: string) => void;
}

const setup = (fakes: SetupOptions = {}) => {
  let onInput: (data: string) => void = () => undefined;
  let written = '';
  /** Writes to the terminal and to the shell, in order. */
  const events: string[] = [];
  const host = {
    size: { cols: 80, rows: 24 },
    start: (listener: (data: string) => void) => (onInput = listener),
    stop: () => undefined,
    onResize: (listener: (size: { cols: number; rows: number }) => void) => {
      resize = listener;
      return () => undefined;
    },
    write: (data: string) => {
      written += data;
      events.push(`terminal ${data}`);
    },
    queryCursorPosition: fakes.cursor ?? (() => Promise.resolve({ row: 5, col: 3 })),
  } as unknown as HostTerminal;

  const toShell: string[] = [];
  const resizes: { cols: number; rows: number }[] = [];
  let resize: (size: { cols: number; rows: number }) => void = () => undefined;
  let shellOutput: (data: string) => void = () => undefined;
  let exit: (code: number) => void = () => undefined;
  let nonce = '';
  const spawnShell = (options: ShellSessionOptions) => {
    nonce = String(options.env.SHELLY_NONCE ?? '');
    return {
      onData: (listener: (data: string) => void) => (shellOutput = listener),
      onExit: (listener: (code: number) => void) => (exit = listener),
      write: (data: string) => {
        toShell.push(data);
        events.push(`shell ${data}`);
        fakes.onShellWrite?.(data);
      },
      resize: (size: { cols: number; rows: number }) => resizes.push(size),
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
    marker,
    events,
    written: () => written,
    toShell,
    resizes,
    resize: (size: { cols: number; rows: number }) => resize(size),
    type: (data: string) => onInput(data),
    shellOutput: (data: string) => shellOutput(data),
    prompt,
    stop: async () => {
      shelly.terminate();
      await running;
    },
    terminate: () => shelly.terminate(),
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

  it('drops what the idle shell drew meanwhile, and what it writes before the new prompt, but not its queries', async () => {
    const t = setup();
    t.prompt();
    t.internals.claim(() => false);
    t.shellOutput('\u001b[2A$ REPAINT\u001b[?2004h');
    t.internals.release(freshLine);
    // fish 4 asks where the cursor is and waits for the answer: the question must reach the terminal.
    t.shellOutput('\r\nLATE-REPAINT\u001b[6n');
    t.prompt();
    await sleep(20);
    assert.ok(!t.written().includes('REPAINT'), JSON.stringify(t.written()));
    assert.ok(t.written().includes('\u001b[?2004h'), 'a mode the shell set goes through');
    assert.ok(t.written().includes('\u001b[6n'), 'a query the shell waits on goes through');
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

  it('resizes the shell only once it has its new prompt, so it never repaints under Shelly\'s output', async () => {
    const t = setup();
    t.prompt();
    t.internals.claim(() => false);
    t.resize({ cols: 70, rows: 20 });
    t.resize({ cols: 84, rows: 22 });
    assert.deepEqual(t.resizes, [], 'not while Shelly draws');
    t.internals.release(freshLine);
    assert.deepEqual(t.resizes, [], 'nor while the prompt comes back');
    t.prompt();
    await sleep(20);
    assert.deepEqual(t.resizes, [{ cols: 84, rows: 22 }], 'the last size, once');
    t.resize({ cols: 90, rows: 24 });
    assert.deepEqual(t.resizes.at(-1), { cols: 90, rows: 24 }, 'at once when the shell has the terminal');
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

const HOTKEY = '\u001d';
const MOVE_TO_END = LINE_KEYS.mark + LINE_KEYS.start + LINE_KEYS.end;
const NOTICE = 'Ctrl+] needs bash 4+';
const BELL = '\u0007';
const ERASE = /^terminal \u001b7(?:\u001b\[\d+;1H\u001b\[2K)+\u001b8$/;

type Position = { row: number; col: number };

/**
 * bash 3.2 at its prompt, with `typed` on the line. The terminal reports
 * the cursor at each of `cursor` in turn (a function may also act, or
 * fail), and the shell answers each key it gets with `answer`'s output, a
 * moment later (none when undefined).
 */
const bash32 = (
  cursor: (Position | (() => Promise<Position>))[],
  { typed = 'echo half', answer = defaultAnswer }: { typed?: string; answer?: (data: string) => string | undefined } = {},
) => {
  const positions = [...cursor];
  const t = setup({
    cursor: () => {
      const next = positions.shift();
      return typeof next === 'function' ? next() : next ? Promise.resolve(next) : Promise.reject(new Error('no answer'));
    },
    onShellWrite: (data) => {
      const output = answer(data);
      if (output !== undefined) {
        setTimeout(() => t.shellOutput(output), 5);
      }
    },
  });
  t.shellOutput(t.marker('line-editor', 'clear,jump'));
  t.prompt();
  if (typed) {
    t.type(typed);
  }
  return t;
};

/** readline moves the cursor: back to the line's start and on to its end, or back to the mark. */
const defaultAnswer = (data: string): string | undefined =>
  data === MOVE_TO_END ? '\r\u001b[11C' : data === LINE_KEYS.back ? '\u001b[2D' : undefined;

const index = (events: string[], predicate: (event: string) => boolean): number => events.findIndex(predicate);

describe('Ctrl+] in bash 3.2, which cannot hand its line over', () => {
  it('draws the notice below the line\'s end, and erases it before a key typed meanwhile reaches the shell', async () => {
    const t = bash32([{ row: 5, col: 10 }, { row: 5, col: 12 }]);
    t.type(`${HOTKEY}X`);
    setTimeout(() => t.type('Y'), 15);
    await sleep(300);
    const { events } = t;
    const notice = index(events, (event) => event.startsWith('terminal \r\n') && event.includes(NOTICE));
    const back = index(events, (event) => event === `shell ${LINE_KEYS.back}`);
    const erase = index(events, (event) => ERASE.test(event));
    const keys = index(events, (event) => event === 'shell XY');
    assert.ok(index(events, (event) => event === `shell ${MOVE_TO_END}`) !== -1, JSON.stringify(events));
    assert.ok(notice !== -1 && events[notice]!.endsWith('\u001b[5;12H'), 'below the end, the cursor back on it');
    assert.ok(notice < back && back < erase && erase < keys, JSON.stringify(events));
    assert.ok(!t.written().includes(BELL));
    await t.stop();
  });

  it('erases the notice before shell output that comes while it shows', async () => {
    const t = bash32([{ row: 5, col: 10 }, { row: 5, col: 12 }]);
    t.type(HOTKEY);
    await sleep(200);
    t.shellOutput('[1]+  Done   sleep 1\r\n');
    const erase = index(t.events, (event) => ERASE.test(event));
    const job = index(t.events, (event) => event.includes('Done   sleep 1'));
    assert.ok(erase !== -1 && erase < job, JSON.stringify(t.events));
    t.shellOutput('more');
    assert.equal(t.events.filter((event) => ERASE.test(event)).length, 1, 'erased once');
    await t.stop();
  });

  it('draws at the cursor, moving nothing, on a line known to be empty', async () => {
    const t = bash32([{ row: 5, col: 3 }], { typed: '' });
    t.type(HOTKEY);
    await sleep(100);
    assert.ok(!t.toShell.some((data) => data.includes(LINE_KEYS.mark) || data.includes(LINE_KEYS.back)), JSON.stringify(t.toShell));
    assert.ok(t.events.some((event) => event.includes(NOTICE) && event.endsWith('\u001b[5;3H')));
    await t.stop();
  });

  it('rings the bell and moves nothing when the terminal will not say where the cursor is', async () => {
    const t = bash32([]);
    t.type(HOTKEY);
    await sleep(100);
    assert.ok(t.written().includes(BELL));
    assert.ok(!t.written().includes(NOTICE));
    assert.ok(!t.toShell.some((data) => data.includes(LINE_KEYS.mark)));
    await t.stop();
  });

  it('rings the bell, and puts the cursor back, when the line\'s end cannot be asked for', async () => {
    const t = bash32([{ row: 5, col: 10 }]);
    t.type(HOTKEY);
    await sleep(250);
    assert.ok(t.written().includes(BELL));
    assert.ok(!t.written().includes(NOTICE));
    assert.ok(t.toShell.includes(LINE_KEYS.back), 'the cursor goes back');
    await t.stop();
  });

  it('gives up on a shell too slow to move the cursor rather than draw in the wrong row', async () => {
    const t = bash32([{ row: 5, col: 10 }, { row: 5, col: 10 }], { answer: () => undefined });
    t.type(HOTKEY);
    await sleep(700);
    assert.ok(t.written().includes(BELL));
    assert.ok(!t.written().includes(NOTICE));
    assert.ok(t.toShell.includes(LINE_KEYS.back));
    await t.stop();
  });

  it('asks again while the shell is still moving the cursor', async () => {
    const t = bash32([
      { row: 5, col: 10 },
      // More of the move comes while the terminal is being asked.
      () => {
        t.shellOutput('\u001b[C');
        return Promise.resolve({ row: 5, col: 11 });
      },
      { row: 5, col: 12 },
    ]);
    t.type(HOTKEY);
    await sleep(300);
    assert.ok(t.events.some((event) => event.includes(NOTICE) && event.endsWith('\u001b[5;12H')), JSON.stringify(t.events));
    await t.stop();
  });

  it('gives up if the shell never stops moving the cursor', async () => {
    const busy = (): Promise<Position> => {
      t.shellOutput('\u001b[C');
      return Promise.resolve({ row: 5, col: 12 });
    };
    const t = bash32([{ row: 5, col: 10 }, busy, busy, busy, busy]);
    t.type(HOTKEY);
    await sleep(400);
    assert.ok(t.written().includes(BELL));
    assert.ok(!t.written().includes(NOTICE));
    await t.stop();
  });

  it('does not trust an end before where the cursor was', async () => {
    const t = bash32([{ row: 5, col: 10 }, { row: 5, col: 4 }]);
    t.type(HOTKEY);
    await sleep(250);
    assert.ok(t.written().includes(BELL));
    assert.ok(!t.written().includes(NOTICE));
    assert.ok(t.toShell.includes(LINE_KEYS.back));
    await t.stop();
  });

  it('draws nothing and rings nothing once shut down mid-way', async () => {
    const t = bash32([{ row: 5, col: 10 }, { row: 5, col: 12 }], { answer: () => undefined });
    t.type(HOTKEY);
    await sleep(50);
    await t.stop();
    await sleep(100);
    assert.ok(!t.written().includes(NOTICE));
    assert.ok(!t.written().includes(BELL));
  });
});

describe('withoutDrawing', () => {
  it('keeps queries and modes, drops text, moves and erases', () => {
    assert.equal(
      withoutDrawing('\r\u001b[2A\u001b[K$ prompt\u001b[6n\u001b[?2004h\u001b[>1u\u001b[?u\u001b[s\u001b[u\u001b]0;title\u0007\u001bPq\u001b\\\u001b7'),
      '\u001b[6n\u001b[?2004h\u001b[>1u\u001b[?u\u001b]0;title\u0007\u001bPq\u001b\\',
    );
  });
});

describe('printableOnly', () => {
  it('keeps text, drops keys and escape sequences', () => {
    assert.equal(printableOnly('git st\u001b[Datus\r\u0003\u001bOA ok'), 'git status ok');
  });
});
