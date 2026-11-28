import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { after, describe, it } from 'node:test';
import type { DaemonLink } from './client/daemon-link.js';
import type { OpenInput, ReleaseOptions } from './client/flow-host.js';
import type { ShellSessionOptions } from './shell/shell-session.js';
import { LINE_KEYS } from './shell/line-editor.js';
import { until } from '../test/support/shelly-rig.js';
import type { HostTerminal } from './terminal/host-terminal.js';

/*
 * The hand-over between Shelly and the shell, with a fake terminal and a
 * fake shell: Shelly draws (busy), gives the prompt back (returning), and
 * the shell has its line again. The user is never locked out.
 */

process.env.SHELLY_BUSY_WATCHDOG_MS = '200';
process.env.SHELLY_PROMPT_WAIT_MS = '300';
process.env.SHELLY_LINE_SET_WAIT_MS = '200';
const { Shelly, printableOnly, replayable, withoutDrawing } = await import('./shelly.js');

const home = mkdtempSync(join(tmpdir(), 'shelly-unit-'));
after(() => rmSync(home, { recursive: true, force: true }));

interface Internals {
  mode: string;
  lineEditor: { replace(text: string): Promise<void>; restore(line: { buffer: string; cursor: number }): Promise<void> };
  openOverlay(trigger: string, remainder: string, rewrite?: OpenInput['rewrite']): Promise<void>;
  overlayLoad: Promise<unknown> | undefined;
  open: OpenInput | undefined;
  claim(open: OpenInput, onKeys: (data: string) => boolean): number | undefined;
  release(options: ReleaseOptions, claim?: number): void;
}

/** As a flow does: from an open input (no overlay here, so a stand-in for one), take the terminal. */
const take = (internals: Internals, onKeys: (data: string) => boolean = () => false): number => {
  const open: OpenInput = { trigger: '::', mode: 'agent', rewrite: undefined };
  internals.mode = 'overlay';
  internals.open = open;
  const claim = internals.claim(open, onKeys);
  assert.ok(claim !== undefined, 'the claim was taken');
  return claim;
};

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
  let lineFile = '';
  const spawnShell = (options: ShellSessionOptions) => {
    nonce = String(options.env.SHELLY_NONCE ?? '');
    lineFile = String(options.env.SHELLY_LINE_FILE ?? '');
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
  const calls = { startDaemon: 0, get: 0 };
  const link = {
    startDaemon: () => {
      calls.startDaemon++;
      return Promise.reject(new Error('no daemon here'));
    },
    get: () => {
      calls.get++;
      return Promise.reject(new Error('no daemon here'));
    },
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
    calls,
    written: () => written,
    toShell,
    resizes,
    resize: (size: { cols: number; rows: number }) => resize(size),
    type: (data: string) => onInput(data),
    shellOutput: (data: string) => shellOutput(data),
    prompt,
    /** The request number in the line file, as the hooks read it. */
    request: () => Number(/^\w+ (\d+)/.exec(readFileSync(lineFile, 'utf8'))?.[1]),
    stop: async () => {
      shelly.terminate();
      await running;
    },
    terminate: () => shelly.terminate(),
  };
};

const freshLine: ReleaseOptions = { cursor: 'fresh-line', line: { type: 'as-before' } };

describe('Shelly asks the shell about a line it lost track of', () => {
  const UP = '\u001b[A';
  const CTRL_U = '\u0015';

  /** At a prompt in a shell that can be asked, after ↑ (so the line is unknown); `queries` collects each request asked. */
  const recalled = () => {
    const queries: number[] = [];
    const t = setup({
      onShellWrite: (data) => {
        if (data.includes(LINE_KEYS.query)) {
          queries.push(t.request());
        }
      },
    });
    t.shellOutput(t.marker('line-editor', 'capture,set,notice,query'));
    t.prompt();
    t.type(UP);
    const sent = () => t.toShell.join('');
    /** Everything sent to the shell after the query key. */
    const afterQuery = () => sent().slice(sent().lastIndexOf(LINE_KEYS.query) + LINE_KEYS.query.length);
    const answer = (buffer: string, cursor = [...buffer].length) =>
      t.shellOutput(t.marker('query', `${queries.at(-1)};${encodeURIComponent(buffer)};${cursor}`));
    return { t, queries, sent, afterQuery, answer };
  };

  it('opens the input on a trigger once the shell says Ctrl+U emptied the line', async () => {
    const { t, queries, sent, answer } = recalled();
    t.type(CTRL_U);
    t.type(':');
    assert.equal(queries.length, 1, 'asked at the first trigger character');
    t.type(':how do I');
    assert.ok(!sent().includes(':'), 'nothing of it reaches the shell meanwhile');
    answer('');
    await sleep(20);
    assert.ok(['opening', 'overlay'].includes(t.internals.mode), t.internals.mode);
    assert.ok(!sent().includes(':'), 'nor after');
    await t.stop();
  });

  it('sends the keys on in the order typed when the line holds text, and follows it from there', async () => {
    const { t, queries, afterQuery, answer } = recalled();
    t.type(':');
    t.type(':b');
    answer('ls -l');
    await sleep(5);
    assert.equal(afterQuery(), '::b');
    t.type(' :');
    assert.equal(queries.length, 1, 'the line is known now: no second question');
    assert.equal(afterQuery(), '::b :');
    await t.stop();
  });

  it('keeps a rewrite hotkey typed while asking behind the keys before it', async () => {
    const { t, answer, afterQuery } = recalled();
    t.type(':');
    t.type('x\u001d');
    answer('ls');
    await sleep(5);
    // The line holds text, so the colon is text; then the hotkey takes the line.
    assert.equal(afterQuery(), `:x${LINE_KEYS.capture}`);
    assert.equal(t.internals.mode, 'capturing');
    await t.stop();
  });

  it('sends the keys on, without waiting long, when the shell does not answer', async () => {
    const { t, queries, sent } = recalled();
    t.type(':');
    assert.equal(queries.length, 1);
    await sleep(60);
    assert.ok(!sent().endsWith(':'), 'held a moment');
    await sleep(200);
    assert.ok(sent().endsWith(':'), 'then sent');
    await t.stop();
  });
});

describe('Shelly loads on first use', () => {
  it('starts the daemon at the first prompt, but loads neither the UI nor the connection', async () => {
    const t = setup();
    t.prompt();
    await sleep(400);
    assert.equal(t.calls.startDaemon, 1);
    assert.equal(t.calls.get, 0);
    assert.equal(t.internals.overlayLoad, undefined);
    t.type('ls -la:');
    await sleep(20);
    assert.equal(t.internals.overlayLoad, undefined, 'a colon in a command is no trigger');
    await t.stop();
  });

  it('loads both from the first character of a trigger at an empty prompt', async () => {
    const t = setup();
    t.prompt();
    t.type(':');
    assert.notEqual(t.internals.overlayLoad, undefined);
    await t.internals.overlayLoad;
    assert.equal(t.calls.get, 1);
    // Nothing followed: the colon goes to the shell.
    await sleep(450);
    assert.ok(t.toShell.includes(':'), JSON.stringify(t.toShell));
    await t.stop();
  });
});

describe('Shelly hands the terminal back', () => {
  it('gives the prompt back on its own when busy with nothing drawing (an error lost on the way)', async () => {
    const t = setup();
    t.prompt();
    take(t.internals);
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
    const claim = take(t.internals);
    t.type('ls\u001b[A -la\r');
    t.internals.release(freshLine, claim);
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
    const claim = take(t.internals);
    t.shellOutput('\u001b[2A$ REPAINT\u001b[?2004h');
    t.internals.release(freshLine, claim);
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
    const claim = take(t.internals);
    t.internals.release(freshLine, claim);
    t.type('\u0003x\u0004');
    assert.equal(t.toShell.at(-1), '\u0003', 'Ctrl-C at once');
    t.prompt();
    await sleep(20);
    assert.equal(t.toShell.filter((data) => data.includes('\u0003')).length, 1, 'and never again');
    assert.equal(t.toShell.at(-1), 'x');
    assert.ok(!t.toShell.some((data) => data.includes('\u0004')), 'Ctrl-D dropped');
    await t.stop();
  });

  it('passes the terminal\'s answers to the shell at once while it gets its line back, and holds the keys', async () => {
    const t = setup();
    t.prompt();
    const claim = take(t.internals);
    t.internals.release(freshLine, claim);
    // fish 4 asks while its line is set: where the cursor is, and the terminal's attributes.
    t.shellOutput('\u001b[6n\u001b[c');
    t.type('a\u001b[12;5Rb\u001b[?62;22c');
    assert.equal(t.toShell.at(-1), '\u001b[12;5R\u001b[?62;22c', 'the replies, now: the shell is waiting for them');
    t.prompt();
    await sleep(20);
    assert.equal(t.toShell.at(-1), 'ab', 'the keys after the prompt');
    await t.stop();
  });

  it('passes the answer to a query the shell asked just before Shelly took the terminal, while busy', async () => {
    const t = setup();
    t.prompt();
    t.shellOutput('\u001b[6n');
    let keys = '';
    take(t.internals, (data) => {
      keys += data;
      return true;
    });
    assert.equal(t.internals.mode, 'busy');
    t.type('\u001b[5;3Rq');
    assert.equal(t.toShell.at(-1), '\u001b[5;3R', 'to the shell, at once');
    assert.equal(keys, 'q', 'only the key to what Shelly draws');
    await t.stop();
  });

  it('passes the answer to the shell while the input is open, not to the input as keys', async () => {
    const t = setup();
    t.prompt();
    t.shellOutput('\u001b[c');
    t.internals.mode = 'overlay';
    t.type('\u001b[?62;22c');
    assert.equal(t.toShell.at(-1), '\u001b[?62;22c');
    t.internals.mode = 'shell';
    await t.stop();
  });

  it('holds a key that looks like an answer (Ctrl+F3) when no query waits for one', async () => {
    const t = setup();
    t.prompt();
    const claim = take(t.internals);
    t.internals.release(freshLine, claim);
    const before = t.toShell.length;
    t.type('a\u001b[1;5Rb');
    assert.equal(t.toShell.length, before, 'nothing sent at once');
    t.prompt();
    await sleep(20);
    assert.equal(t.toShell.at(-1), 'ab', 'with the keys, then dropped as a key that acts');
    await t.stop();
  });

  it('resizes the shell only once it has its new prompt, so it never repaints under Shelly\'s output', async () => {
    const t = setup();
    t.prompt();
    const claim = take(t.internals);
    t.resize({ cols: 70, rows: 20 });
    t.resize({ cols: 84, rows: 22 });
    assert.deepEqual(t.resizes, [], 'not while Shelly draws');
    t.internals.release(freshLine, claim);
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
    const claim = take(t.internals);
    t.internals.release(freshLine, claim);
    t.internals.release(freshLine, claim);
    assert.equal(t.toShell.filter((data) => data === '\r').length, 1);
    await t.stop();
  });
});

const PASTE = '\u001b[200~cd /tmp\nls -la\u001b[201~';
const asBefore: ReleaseOptions = { cursor: 'prompt', line: { type: 'as-before' } };
const setLine: ReleaseOptions = { cursor: 'prompt', line: { type: 'set', text: 'git status' } };

describe('a paste typed while Shelly had the terminal', () => {
  /** The shell at its prompt, with `modes` in its prompt's output (zsh turns bracketed paste on there). */
  const atPrompt = (features: string, modes: string) => {
    const t = setup();
    t.shellOutput(t.marker('line-editor', features));
    t.shellOutput(`${t.marker('cwd', encodeURIComponent(home))}${modes}$ `);
    return t;
  };

  it('bash 3.2, without bracketed paste: one line of text, no markers, no newline to run it', async () => {
    const t = atPrompt('clear,jump', '');
    const claim = take(t.internals);
    t.type(PASTE);
    t.internals.release(asBefore, claim);
    assert.equal(t.internals.mode, 'shell');
    const sent = t.toShell.join('');
    assert.ok(sent.includes('cd /tmp ls -la'), JSON.stringify(t.toShell));
    assert.ok(!/[\r\n]|\u001b\[20[01]~/.test(sent), JSON.stringify(t.toShell));
    await t.stop();
  });

  it('zsh, with bracketed paste on: the paste whole', async () => {
    const t = atPrompt('capture,set,notice,query', '\u001b[?2004h');
    const claim = take(t.internals);
    t.type(PASTE);
    t.internals.release(asBefore, claim);
    assert.equal(t.toShell.at(-1), PASTE);
    await t.stop();
  });

  it('a shell that turned bracketed paste off again: one line of text', async () => {
    const t = atPrompt('capture,set,notice,query', '\u001b[?2004h');
    t.shellOutput('\u001b[?2004l');
    const claim = take(t.internals);
    t.type(PASTE);
    t.internals.release(asBefore, claim);
    assert.equal(t.toShell.at(-1), 'cd /tmp ls -la');
    await t.stop();
  });
});

describe('keys typed while Shelly sets the shell\'s line', () => {
  const atZshPrompt = () => {
    const t = setup();
    t.shellOutput(t.marker('line-editor', 'capture,set,notice,query'));
    t.shellOutput(`${t.marker('cwd', encodeURIComponent(home))}\u001b[?2004h$ `);
    return t;
  };
  const sent = (t: ReturnType<typeof setup>) => t.toShell.join('');

  it('a set that never finishes: the keys go on after a while, as text, never Enter', async () => {
    const t = atZshPrompt();
    t.internals.lineEditor.replace = () => new Promise(() => undefined);
    const claim = take(t.internals);
    t.internals.release(setLine, claim);
    assert.equal(t.internals.mode, 'returning');
    t.type('ab\r');
    assert.ok(!sent(t).includes('ab'), 'not under the set');
    await until(() => t.internals.mode === 'shell', 'the shell back', 2000);
    assert.ok(sent(t).endsWith('ab'), JSON.stringify(t.toShell));
    await t.stop();
  });

  it('a set that fails: a bell, and a paste typed meanwhile as text only', async () => {
    const t = atZshPrompt();
    t.internals.lineEditor.replace = () => sleep(30).then(() => Promise.reject(new Error('no answer')));
    const claim = take(t.internals);
    t.internals.release(setLine, claim);
    t.type(PASTE);
    await until(() => t.internals.mode === 'shell', 'the shell back');
    assert.ok(t.written().includes(BELL));
    assert.equal(t.toShell.at(-1), 'cd /tmp ls -la');
    await t.stop();
  });

  it('a set that finishes after Shelly shut down: nothing more reaches the shell', async () => {
    const t = atZshPrompt();
    let finish: () => void = () => undefined;
    t.internals.lineEditor.replace = () => new Promise((resolve) => (finish = resolve));
    const claim = take(t.internals);
    t.internals.release(setLine, claim);
    t.type('rm -rf x');
    await t.stop();
    finish();
    await sleep(20);
    assert.ok(!sent(t).includes('rm -rf x'), JSON.stringify(t.toShell));
  });

  it('a rewrite whose input cannot open: keys typed while its line goes back wait for it', async () => {
    const t = setup({ cursor: () => Promise.reject(new Error('no answer')) });
    t.shellOutput(t.marker('line-editor', 'capture,set,notice,query'));
    t.prompt();
    let restored: () => void = () => undefined;
    let restoring = false;
    t.internals.lineEditor.restore = () => {
      restoring = true;
      return new Promise((resolve) => (restored = resolve));
    };
    const opening = t.internals.openOverlay('__', 'typed', { captured: { buffer: 'echo hi', cursor: 7 } });
    await until(() => restoring, 'the line going back');
    await opening;
    assert.equal(t.internals.mode, 'returning');
    t.type('x');
    assert.ok(!sent(t).includes('x'), JSON.stringify(t.toShell));
    restored();
    await until(() => t.internals.mode === 'shell', 'the shell back');
    await sleep(5);
    assert.ok(sent(t).endsWith('typedx'), JSON.stringify(t.toShell));
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

  it('drops an Enter typed before the notice shows, and passes one typed after it to the shell', async () => {
    const t = bash32([{ row: 5, col: 10 }, { row: 5, col: 12 }]);
    t.type(`${HOTKEY}a\r`);
    for (let i = 0; i < 50 && !t.events.some((event) => event.includes(NOTICE)); i++) {
      await sleep(2);
    }
    t.type('\r');
    await sleep(300);
    const sent = t.toShell.join('');
    assert.equal(sent.split('\r').length - 1, 1, `one Enter, the one typed after the notice: ${JSON.stringify(t.toShell)}`);
    assert.ok(sent.indexOf('a') < sent.indexOf('\r'), 'the text typed before it, as text, first');
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
    // Retries and the move back take a while, longer on a loaded machine: wait for the outcome itself.
    await until(() => t.written().includes(BELL), 'the bell', 5000);
    assert.ok(t.written().includes(BELL));
    assert.ok(!t.written().includes(NOTICE));
    assert.ok(t.toShell.includes(LINE_KEYS.back), 'the cursor goes back');
    await t.stop();
  });

  it('gives up on a shell too slow to move the cursor rather than draw in the wrong row', async () => {
    const t = bash32([{ row: 5, col: 10 }, { row: 5, col: 10 }], { answer: () => undefined });
    t.type(HOTKEY);
    // Retries and the move back take a while, longer on a loaded machine: wait for the outcome itself.
    await until(() => t.written().includes(BELL), 'the bell', 5000);
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
    // Retries and the move back take a while, longer on a loaded machine: wait for the outcome itself.
    await until(() => t.written().includes(BELL), 'the bell', 5000);
    assert.ok(t.written().includes(BELL));
    assert.ok(!t.written().includes(NOTICE));
    await t.stop();
  });

  it('does not trust an end before where the cursor was', async () => {
    const t = bash32([{ row: 5, col: 10 }, { row: 5, col: 4 }]);
    t.type(HOTKEY);
    // Retries and the move back take a while, longer on a loaded machine: wait for the outcome itself.
    await until(() => t.written().includes(BELL), 'the bell', 5000);
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

describe('replayable', () => {
  it('keeps a bracketed paste whole, newlines and all, and only the text around it, for a shell that takes pastes', () => {
    assert.equal(replayable('a\r\u001b[200~cd /tmp\nls\u001b[201~\u001b[Ab\r', { pastes: true }), 'a\u001b[200~cd /tmp\nls\u001b[201~b');
  });

  it('makes a paste one line of text, never an Enter, for a shell that does not', () => {
    assert.equal(replayable('a\u001b[200~cd /tmp\r\nls\tx\u001b[201~b', { pastes: false }), 'acd /tmp ls xb');
  });

  it('treats a paste that has not ended as typed text', () => {
    assert.equal(replayable('\u001b[200~rm -rf\n', { pastes: true }), 'rm -rf');
  });
});
