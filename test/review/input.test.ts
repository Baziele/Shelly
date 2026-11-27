import assert from 'node:assert/strict';
import { describe, it, afterEach } from 'node:test';
import { PassThrough } from 'node:stream';
import { HostTerminal } from '../../src/terminal/host-terminal.js';
import { ev, setup } from './support.js';
import type { AgentView } from '../../src/ui/agent/agent-view.js';

const permission = ev({
  type: 'permission.requested', requestId: 'p1', toolCallId: null, title: 'Run `rm -rf build`',
  options: [
    { optionId: 'once', name: 'Allow once', kind: 'allow_once' },
    { optionId: 'no', name: 'Reject', kind: 'reject_once' },
  ],
});

let view: AgentView | undefined;
afterEach(() => { view?.destroy(); view = undefined; });

describe('review: input', () => {
  it('a bracketed paste containing "y" must not answer a permission prompt', async () => {
    const s = await setup(80, 24);
    view = s.view;
    s.view.apply(permission);
    // The user pastes a sentence meant for the shell / next prompt; zsh has bracketed paste on.
    s.view.handleInput('\u001b[200~hey, why is this slow?\u001b[201~');
    assert.deepEqual(s.actions, [], `paste answered the prompt: ${JSON.stringify(s.actions)}`);
  });

  it('a plain multi-char burst (typed-ahead text) must not answer either', async () => {
    const s = await setup(80, 24);
    view = s.view;
    s.view.apply(permission);
    s.view.handleInput('git status\r');
    assert.deepEqual(s.actions, [], `typed-ahead answered the prompt: ${JSON.stringify(s.actions)}`);
  });

  it('Shift+F3 (CSI 1;2 R) while a cursor query is pending is not a cursor report', async () => {
    const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode() { return this; } });
    const output = Object.assign(new PassThrough(), { isTTY: true, columns: 80, rows: 24 });
    const host = new HostTerminal(input as never, output as never);
    const typed: string[] = [];
    host.start((d) => typed.push(d));
    const query = host.queryCursorPosition();
    input.write('\u001b[1;2R'); // Shift+F3 in xterm, kitty, iTerm2
    input.write('\u001b[17;5R'); // the real report
    const position = await query;
    host.stop();
    assert.deepEqual(position, { row: 17, col: 5 }, `took the key as the report; typed=${JSON.stringify(typed)}`);
  });

  it('a second cursor query while one is in flight (resize during query) is rejected', async () => {
    const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode() { return this; } });
    const output = Object.assign(new PassThrough(), { isTTY: true, columns: 80, rows: 24 });
    const host = new HostTerminal(input as never, output as never);
    host.start(() => {});
    const first = host.queryCursorPosition();
    const second = host.queryCursorPosition().then(() => 'ok', (e: Error) => `rejected: ${e.message}`);
    input.write('\u001b[3;1R');
    await first;
    const result = await second;
    host.stop();
    assert.equal(result, 'ok', result);
  });

  it('HostTerminal.stop() (crash path) restores the cursor', async () => {
    const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode() { return this; } });
    const output = Object.assign(new PassThrough(), { isTTY: true, columns: 80, rows: 24 });
    let written = '';
    output.on('data', (d) => { written += d; });
    const host = new HostTerminal(input as never, output as never);
    host.start(() => {});
    host.write('\u001b[?2026h\u001b[?25l\u001b[1;35mpartial'); // e.g. a crash mid-update
    host.stop();
    await new Promise((r) => setImmediate(r));
    assert.match(written.slice(written.lastIndexOf('partial')), /\u001b\[\?25h/, 'cursor left hidden');
  });
});

describe('review: late cursor report', () => {
  it('a report arriving after the timeout (slow SSH) is not typed into the shell', async () => {
    const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode() { return this; } });
    const output = Object.assign(new PassThrough(), { isTTY: true, columns: 80, rows: 24 });
    const host = new HostTerminal(input as never, output as never);
    const typed: string[] = [];
    host.start((d) => typed.push(d));
    await host.queryCursorPosition(50).catch(() => undefined);
    input.write('\u001b[12;3R');
    await new Promise((r) => setImmediate(r));
    host.stop();
    assert.deepEqual(typed, [], `forwarded to the shell: ${JSON.stringify(typed)}`);
  });
});
