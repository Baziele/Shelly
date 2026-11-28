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

  it('does not take an earlier query\'s owed reply as the answer to the next', async () => {
    const { host, typed, answer } = fakeTerminal();
    // `::` asks; the DEC answer settles it, its plain echo is still on the way.
    const first = host.queryCursorPosition();
    await answer('\u001b[?7;3R');
    assert.deepEqual(await first, { row: 7, col: 3 });
    // A quick submit asks again before that echo arrives.
    const second = host.queryCursorPosition();
    await answer('\u001b[7;3R');
    await answer('\u001b[?8;1R\u001b[8;1R');
    assert.deepEqual(await second, { row: 8, col: 1 }, 'the second query gets its own answer');
    await answer('x');
    host.stop();
    assert.equal(typed.join(''), 'x', 'no reply reaches the shell');
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

describe('HostTerminal teardown', () => {
  /** A started HostTerminal over `output`, recording each raw mode it sets. */
  const started = (output: PassThrough) => {
    const modes: boolean[] = [];
    const input = Object.assign(new PassThrough(), {
      isTTY: true,
      setRawMode(mode: boolean) {
        modes.push(mode);
        return this;
      },
    });
    const host = new HostTerminal(input as never, Object.assign(output, { isTTY: true, columns: 80, rows: 24 }) as never);
    host.start(() => undefined);
    return { host, modes };
  };

  it('restores the mode first, then survives an output that fails as it is written to (EPIPE)', () => {
    const output = new PassThrough();
    let writes = 0;
    output.write = (() => {
      writes++;
      throw Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
    }) as never;
    const { host, modes } = started(output);
    assert.doesNotThrow(() => host.stop());
    assert.deepEqual(modes, [true, false]);
    assert.equal(writes, 1);
    assert.doesNotThrow(() => host.stop());
    assert.equal(writes, 1, 'a second stop writes nothing');
  });

  for (const ending of ['destroyed', 'ended'] as const) {
    it(`restores the mode and raises no error with the output already ${ending}`, async () => {
      const output = new PassThrough();
      const errors: Error[] = [];
      output.on('error', (error) => errors.push(error));
      output.resume();
      const { host, modes } = started(output);
      if (ending === 'destroyed') {
        output.destroy();
      } else {
        output.end();
      }
      await sleep(5);
      host.stop();
      host.stop();
      await sleep(5);
      assert.deepEqual(modes, [true, false, false]);
      assert.deepEqual(errors, []);
    });
  }
});

describe('HostTerminal width queries', () => {
  it('pushes the cursor to the right edge, asks where it is, and goes back to column 1', async () => {
    const { host, typed, answer, written } = fakeTerminal();
    const width = host.queryWidth();
    await sleep(1);
    assert.ok(written().endsWith('\u001b[9999C\u001b[?6n\u001b[6n\r'), JSON.stringify(written()));
    await answer('\u001b[?7;60R\u001b[7;60R');
    assert.deepEqual(await width, { row: 7, cols: 60 });
    host.stop();
    assert.deepEqual(typed, []);
  });

  it('asks only once a query in flight is answered, instead of sharing its answer', async () => {
    const { host, answer, written } = fakeTerminal();
    const position = host.queryCursorPosition();
    const width = host.queryWidth();
    await sleep(1);
    assert.ok(!written().includes('9999C'), 'asked while another query was in flight');
    await answer('\u001b[?3;1R\u001b[3;1R');
    assert.deepEqual(await position, { row: 3, col: 1 });
    await sleep(1);
    await answer('\u001b[?3;80R\u001b[3;80R');
    assert.deepEqual(await width, { row: 3, cols: 80 });
    host.stop();
  });
});

describe('HostTerminal input while a query waits', () => {
  it('passes keystrokes on at once, Ctrl-C included, instead of holding them for the reply', async () => {
    const { host, typed, answer } = fakeTerminal();
    const width = host.queryWidth();
    await answer('ab\u0003');
    assert.deepEqual(typed, ['ab\u0003'], 'typing waited for the reply');
    await answer('c\u001b[?4;80R\u001b[4;80R');
    assert.deepEqual(await width, { row: 4, cols: 80 });
    host.stop();
    assert.deepEqual(typed.join(''), 'ab\u0003c');
  });

  it('holds only the start of a reply cut off at the end of a read, and takes it whole', async () => {
    const { host, typed, answer } = fakeTerminal();
    const position = host.queryCursorPosition();
    await answer('x\u001b[?12;');
    assert.deepEqual(typed, ['x']);
    await answer('80R\u001b[12;80Ry');
    assert.deepEqual(await position, { row: 12, col: 80 });
    host.stop();
    assert.deepEqual(typed.join(''), 'xy');
  });
});

describe('HostTerminal queries one after another', () => {
  it('fails a query queued behind one the terminal never answered at once, instead of stacking a second timeout', async () => {
    const { host } = fakeTerminal();
    const width = host.queryWidth(40);
    const started = Date.now();
    await assert.rejects(width);
    const queued = host.queryWidth(40);
    const position = host.queryCursorPosition(5_000);
    await assert.rejects(queued);
    await assert.rejects(position);
    assert.ok(Date.now() - started < 1_000, `took ${Date.now() - started} ms`);
    host.stop();
  });

  it('counts the wait for the query ahead towards the timeout of the one behind it', async () => {
    const { host, answer } = fakeTerminal();
    const first = host.queryWidth(500);
    const second = assert.rejects(host.queryCursorPosition(60), 'waited for the first, then its own full time out');
    await sleep(80);
    await answer('\u001b[?2;80R\u001b[2;80R');
    assert.deepEqual(await first, { row: 2, cols: 80 });
    await second;
    host.stop();
  });
});
