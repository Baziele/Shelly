import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, it } from 'node:test';
import { HostTerminal } from './host-terminal.js';

/** A HostTerminal over in-memory streams: `answer` plays the terminal, `typed` is what reached the shell. */
const fakeTerminal = () => {
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode() { return this; } });
  const output = Object.assign(new PassThrough(), { isTTY: true, columns: 80, rows: 24 });
  let written = '';
  output.on('data', (data: Buffer) => {
    written += data.toString();
  });
  const host = new HostTerminal(input as never, output as never);
  const typed: string[] = [];
  host.start((data) => typed.push(data));
  const answer = async (data: string) => {
    input.write(data);
    await sleep(5);
  };
  return { host, typed, answer, written: () => written };
};

describe('HostTerminal cursor queries', () => {
  it('asks in both the DEC and the plain form', () => {
    const { host, written } = fakeTerminal();
    void host.queryCursorPosition().catch(() => undefined);
    assert.ok(written().endsWith('\u001b[?6n\u001b[6n'));
    host.stop();
  });

  it('takes the DEC answer and swallows the plain one behind it', async () => {
    const { host, typed, answer } = fakeTerminal();
    const query = host.queryCursorPosition();
    await answer('a\u001b[?5;9R');
    assert.deepEqual(await query, { row: 5, col: 9 });
    await answer('\u001b[5;9Rb');
    host.stop();
    assert.deepEqual(typed.join(''), 'ab');
  });

  it('does not take Shift+F3 (CSI 1;2R) for the report when the real one follows', async () => {
    const { host, typed, answer } = fakeTerminal();
    const query = host.queryCursorPosition();
    await answer('\u001b[1;2R');
    await answer('\u001b[17;5R');
    assert.deepEqual(await query, { row: 17, col: 5 });
    host.stop();
    assert.deepEqual(typed, ['\u001b[1;2R'], 'the key reaches the shell');
  });

  it('takes an ambiguous report when nothing clearer follows (a prompt at the top-left)', async () => {
    const { host, typed, answer } = fakeTerminal();
    const query = host.queryCursorPosition();
    await answer('\u001b[1;3R');
    assert.deepEqual(await query, { row: 1, col: 3 });
    host.stop();
    assert.deepEqual(typed, []);
  });

  it('shares one in-flight query between callers', async () => {
    const { host, answer } = fakeTerminal();
    const first = host.queryCursorPosition();
    const second = host.queryCursorPosition();
    await answer('\u001b[3;1R');
    assert.deepEqual(await first, { row: 3, col: 1 });
    assert.deepEqual(await second, { row: 3, col: 1 });
    host.stop();
  });

  it('keeps a reply that comes after the timeout out of the shell', async () => {
    const { host, typed, answer } = fakeTerminal();
    await assert.rejects(host.queryCursorPosition(30));
    await answer('\u001b[?12;3R\u001b[12;3R');
    await answer('ls');
    host.stop();
    assert.deepEqual(typed.join(''), 'ls');
  });

  it('lets a Shift+F3 through after a DEC answer whose plain echo never came', async () => {
    const { host, typed, answer } = fakeTerminal();
    const query = host.queryCursorPosition();
    await answer('\u001b[?5;9R');
    await query;
    await answer('\u001b[1;2R');
    host.stop();
    assert.deepEqual(typed, ['\u001b[1;2R'], 'the key was taken for the late echo');
  });

  it('lets a key-shaped report through after a timeout, but swallows a late DEC answer and its echo', async () => {
    const { host, typed, answer } = fakeTerminal();
    await assert.rejects(host.queryCursorPosition(30));
    await answer('\u001b[1;2R');
    host.stop();
    assert.deepEqual(typed, ['\u001b[1;2R']);

    const second = fakeTerminal();
    await assert.rejects(second.host.queryCursorPosition(30));
    await second.answer('\u001b[?1;3R\u001b[1;3R');
    second.host.stop();
    assert.deepEqual(second.typed, []);
  });

  it('passes keystrokes typed during a query through once it is answered', async () => {
    const { host, typed, answer } = fakeTerminal();
    const query = host.queryCursorPosition();
    await answer('x\u001b[4;4Ry');
    await query;
    host.stop();
    assert.equal(typed.join(''), 'xy');
  });
});

describe('HostTerminal with replies split across reads', () => {
  const answerSplit = async (answer: (data: string) => Promise<void>, report: string, at: number) => {
    await answer(report.slice(0, at));
    await answer(report.slice(at));
  };

  it('recognises an answer split at any byte while the query waits', async () => {
    const report = '\u001b[?17;5R';
    for (let at = 1; at < report.length; at++) {
      const { host, typed, answer } = fakeTerminal();
      const query = host.queryCursorPosition();
      await answerSplit(answer, report, at);
      assert.deepEqual(await query, { row: 17, col: 5 }, `split at ${at}`);
      host.stop();
      assert.deepEqual(typed, [], `split at ${at}`);
    }
  });

  it('swallows the plain echo of a DEC answer split at any byte, and passes on what follows', async () => {
    const echo = '\u001b[17;5R';
    for (let at = 1; at < echo.length; at++) {
      const { host, typed, answer } = fakeTerminal();
      const query = host.queryCursorPosition();
      await answer('\u001b[?17;5R');
      await query;
      await answerSplit(answer, `${echo}ls`, at);
      host.stop();
      assert.equal(typed.join(''), 'ls', `split at ${at}`);
    }
  });

  it('swallows a late reply split at any byte after a timeout', async () => {
    const late = '\u001b[12;30R';
    for (let at = 1; at < late.length; at++) {
      const { host, typed, answer } = fakeTerminal();
      await assert.rejects(host.queryCursorPosition(20));
      await answerSplit(answer, late, at);
      await sleep(80);
      host.stop();
      assert.deepEqual(typed, [], `split at ${at}`);
    }
  });

  it('passes on a lone Esc after a short wait when no reply follows', async () => {
    const { host, typed, answer } = fakeTerminal();
    const query = host.queryCursorPosition();
    await answer('\u001b[?3;3R');
    await query;
    await answer('\u001b');
    await sleep(80);
    host.stop();
    assert.deepEqual(typed, ['\u001b']);
  });
});

describe('HostTerminal.stop', () => {
  it('fails the query in flight and leaves nothing running that could deliver later', async () => {
    const { host, typed, answer } = fakeTerminal();
    const query = host.queryCursorPosition();
    // An ambiguous report is held on a timer, and a partial one would be too.
    await answer('\u001b[1;2R');
    host.stop();
    await assert.rejects(query, /stopped/);
    await sleep(120);
    assert.deepEqual(typed, []);
  });

  it('forgets owed replies, so a later start passes input on untouched', async () => {
    const { host, answer } = fakeTerminal();
    const query = host.queryCursorPosition();
    await answer('\u001b[?4;4R');
    await query;
    host.stop();
    const typed: string[] = [];
    host.start((data) => typed.push(data));
    await answer('\u001b[4;4R');
    host.stop();
    assert.deepEqual(typed, ['\u001b[4;4R']);
  });


  it('leaves the screen usable after a crash mid-frame: synchronized output ended, style reset, cursor shown', async () => {
    const { host, written } = fakeTerminal();
    host.write('\u001b[?2026h\u001b[?25l\u001b[1;35mpartial');
    host.stop();
    await sleep(5);
    assert.ok(written().endsWith('partial\u001b[?2026l\u001b[0m\u001b[?25h'), JSON.stringify(written()));
    host.stop();
    await sleep(5);
    assert.ok(written().endsWith('partial\u001b[?2026l\u001b[0m\u001b[?25h'), 'a second stop writes nothing');
  });
});
