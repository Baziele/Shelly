import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { LINE_KEYS, LineEditor } from './line-editor.js';

/** The request number Shelly left in the line file, as the hooks read it. */
const requestIn = (file: string | undefined): number | undefined => {
  const match = file && existsSync(file) ? /^(?:capture|set|notice) (\d+)/.exec(readFileSync(file, 'utf8')) : undefined;
  return match ? Number(match[1]) : undefined;
};

describe('LineEditor', () => {
  let runtimeDir: string;
  let editor: LineEditor | undefined;
  let written: string[];
  /** Called with each write, as the shell would see it. */
  let shell: (data: string) => void;

  const create = (features: string[], options: { timeoutMs?: number } = {}): LineEditor => {
    editor = new LineEditor({ write: (data) => { written.push(data); shell(data); }, runtimeDir, settleMs: 1, ...options });
    editor.handleEvent({ type: 'line-editor', features });
    editor.handleEvent({ type: 'cwd', path: '/' });
    return editor;
  };

  beforeEach(() => {
    runtimeDir = mkdtempSync(join(tmpdir(), 'shelly-line-editor-test-'));
    written = [];
    shell = () => undefined;
  });

  afterEach(() => {
    editor?.dispose();
    editor = undefined;
    rmSync(runtimeDir, { recursive: true, force: true });
  });

  it('keeps the line file in a private directory that goes away on dispose', () => {
    const subject = create(['capture', 'set']);
    const dir = dirname(subject.lineFile ?? '');
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    assert.match(subject.lineFile ?? '', /line-[0-9a-f]{24}$/);
    const other = new LineEditor({ write: () => undefined, runtimeDir });
    assert.notEqual(other.lineFile, subject.lineFile, 'a fresh name for each session');
    other.dispose();
    subject.dispose();
    assert.ok(!existsSync(dir));
  });

  it('captures the line, counting the cursor in UTF-16 for callers', async () => {
    const subject = create(['capture', 'set']);
    shell = (data) => {
      assert.equal(data, LINE_KEYS.capture);
      const request = requestIn(subject.lineFile);
      assert.ok(request !== undefined, 'the request is in the line file');
      // "a😀b|c": the shell counts the cursor in characters.
      queueMicrotask(() => subject.handleEvent({ type: 'line', request, line: { buffer: 'a😀bc', cursor: 3 } }));
    };
    assert.deepEqual(await subject.capture(), { buffer: 'a😀bc', cursor: 4 });
  });

  it('waits for the redraw that follows the answer', async () => {
    const subject = create(['capture']);
    shell = () => queueMicrotask(() => {
      subject.handleEvent({ type: 'line', request: 1, line: { buffer: 'ls', cursor: 2 } });
      setTimeout(() => subject.observeOutput('\r$ \u001b[K'), 0);
    });
    let settled = false;
    const capture = subject.capture().then((line) => { settled = true; return line; });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(settled, false);
    assert.deepEqual(await capture, { buffer: 'ls', cursor: 2 });
  });

  it('gives up on a capture the shell does not answer, and puts a late answer back', async () => {
    const subject = create(['capture', 'set'], { timeoutMs: 10 });
    assert.equal(await subject.capture(), undefined);
    written = [];
    // The shell read the request just before Shelly gave up on it.
    subject.handleEvent({ type: 'line', request: 1, line: { buffer: 'late', cursor: 4 } });
    assert.deepEqual(written, [LINE_KEYS.set]);
    assert.equal(readFileSync(subject.lineFile ?? '', 'utf8'), 'set 2 4\nlate');
    subject.handleEvent({ type: 'line-set', request: 2 });
  });

  it('tells a line too long to report from no answer at all', async () => {
    const subject = create(['capture', 'set'], { timeoutMs: 20 });
    shell = () => {
      const request = requestIn(subject.lineFile);
      queueMicrotask(() => subject.handleEvent({ type: 'line', request, line: undefined }));
    };
    assert.deepEqual(await subject.tryCapture(), { status: 'failed', reason: 'too-long' });
    assert.equal(await subject.capture(), undefined);
    written = [];
    shell = () => undefined;
    assert.deepEqual(await subject.tryCapture(), { status: 'failed', reason: 'no-answer' });
    assert.deepEqual(written, [LINE_KEYS.capture], 'nothing is put back for a line the shell kept');
    assert.ok(!existsSync(subject.lineFile ?? ''));
  });

  it('says when it cannot capture at all', async () => {
    assert.deepEqual(await create(['clear', 'redraw']).tryCapture(), { status: 'unsupported' });
    editor?.dispose();
    const away = create(['capture', 'set']);
    away.handleEvent({ type: 'exec', command: 'vim' });
    assert.deepEqual(await away.tryCapture(), { status: 'unsupported' });
  });

  it('has the shell show a one-line notice, through the line file', async () => {
    const subject = create(['capture', 'set', 'notice']);
    const seen: string[] = [];
    shell = (data) => {
      assert.equal(data, LINE_KEYS.notice);
      seen.push(readFileSync(subject.lineFile ?? '', 'utf8'));
      const request = requestIn(subject.lineFile);
      queueMicrotask(() => subject.handleEvent({ type: 'line-set', request }));
    };
    await subject.notify('could not\nread \u001b[31mit');
    assert.deepEqual(seen, ['notice 1\ncould not read [31mit']);
    assert.ok(!existsSync(subject.lineFile ?? ''));
    await assert.rejects(create(['capture', 'set']).notify('x'), /cannot show a notice/);
  });

  it('does nothing away from the prompt', async () => {
    const subject = create(['capture', 'set']);
    subject.handleEvent({ type: 'exec', command: 'vim' });
    assert.equal(subject.isAtPrompt, false);
    assert.equal(await subject.capture(), undefined);
    await assert.rejects(subject.replace('ls'), /not at its prompt/);
    assert.deepEqual(written, []);
  });

  it('sets the line through a file only the user can read, gone once the shell has it', async () => {
    const subject = create(['capture', 'set']);
    const file = subject.lineFile ?? '';
    const seen: { content: string; mode: number }[] = [];
    shell = (data) => {
      assert.equal(data, LINE_KEYS.set);
      seen.push({ content: readFileSync(file, 'utf8'), mode: statSync(file).mode & 0o777 });
      const request = requestIn(file);
      // An acknowledgement of some other request changes nothing.
      queueMicrotask(() => subject.handleEvent({ type: 'line-set', request: 99 }));
      setTimeout(() => subject.handleEvent({ type: 'line-set', request }), 5);
    };
    await subject.replace("echo '$HOME' \"!!\"\n\tdone 😀");
    await subject.restore({ buffer: 'a😀bc', cursor: 3 });
    assert.deepEqual(seen, [
      { content: "set 1 25\necho '$HOME' \"!!\"\n\tdone 😀", mode: 0o600 },
      { content: 'set 2 2\na😀bc', mode: 0o600 },
    ]);
    assert.ok(!existsSync(file));
  });

  it('removes the file when the shell does not take it', async () => {
    const subject = create(['set'], { timeoutMs: 10 });
    await assert.rejects(subject.replace('ls'), /did not answer/);
    assert.ok(!existsSync(subject.lineFile ?? ''));
  });

  it('sends keys for one operation at a time, the first straight away', async () => {
    const subject = create(['capture', 'set']);
    shell = (data) => {
      const request = requestIn(subject.lineFile);
      queueMicrotask(() => subject.handleEvent(
        data === LINE_KEYS.capture ? { type: 'line', request, line: { buffer: 'x', cursor: 1 } } : { type: 'line-set', request },
      ));
    };
    const first = subject.replace('one');
    assert.deepEqual(written, [LINE_KEYS.set], 'written before replace() returns');
    const second = subject.capture();
    assert.deepEqual(written, [LINE_KEYS.set]);
    await first;
    assert.deepEqual(await second, { buffer: 'x', cursor: 1 });
    assert.deepEqual(written, [LINE_KEYS.set, LINE_KEYS.capture]);
  });

  describe('without a way to set the line (bash 3.2)', () => {
    it('clears it and types a single line, control characters removed', async () => {
      const subject = create(['clear', 'redraw']);
      assert.equal(subject.canCapture, false);
      assert.equal(subject.canReplace, true);
      await subject.replace('ls\t-la\u0007 😀');
      assert.deepEqual(written, [`${LINE_KEYS.clear}ls -la 😀`]);
      await assert.rejects(subject.replace('one\ntwo'), /single-line/);
    });

    it('pastes when the shell has bracketed paste on', async () => {
      const subject = create(['clear']);
      subject.observeOutput('\u001b[?2004h$ ');
      await subject.replace('one\r\ntwo\u001b[201~');
      assert.deepEqual(written, [`${LINE_KEYS.clear}\u001b[200~one\ntwo[201~\u001b[201~`]);
      subject.observeOutput('\u001b[?2004l');
      await assert.rejects(subject.replace('one\ntwo'), /single-line/);
    });

    it('can redraw the line in place of capturing it', () => {
      const subject = create(['clear', 'redraw']);
      assert.equal(subject.redraw(), true);
      assert.deepEqual(written, [LINE_KEYS.redraw]);
    });
  });

  it('keeps its private keys from being typed at the prompt, and notes Enter', () => {
    const subject = create(['capture', 'set']);
    assert.equal(subject.filterInput(`a${LINE_KEYS.capture}b${LINE_KEYS.set}\u001b[24~`), 'ab\u001b[24~');
    assert.equal(subject.filterInput('\u001b[200~x\ny\u001b[201~'), '\u001b[200~x\ny\u001b[201~');
    assert.equal(subject.isAtPrompt, true, 'a pasted newline is not Enter');
    subject.filterInput('ls\r');
    assert.equal(subject.isAtPrompt, false);
    assert.equal(subject.filterInput(LINE_KEYS.capture), LINE_KEYS.capture, 'a running program gets every key');
  });

  it('matches each answer to its request, and puts back only one that came too late', async () => {
    const subject = create(['capture', 'set'], { timeoutMs: 20 });
    const file = subject.lineFile ?? '';
    const requests: (number | undefined)[] = [];
    const lines: string[] = [];
    shell = (data) => {
      const content = existsSync(file) ? readFileSync(file, 'utf8') : '';
      if (data === LINE_KEYS.capture) {
        requests.push(/^capture (\d+)\n$/.test(content) ? Number(content.slice(8, -1)) : undefined);
      } else if (data === LINE_KEYS.set) {
        lines.push(content);
        const request = Number(/^set (\d+) /.exec(content)?.[1]);
        queueMicrotask(() => subject.handleEvent({ type: 'line-set', request }));
      }
    };

    assert.equal(await subject.capture(), undefined, 'the first capture times out');
    assert.ok(!existsSync(file), 'its request is withdrawn');
    const second = subject.capture();
    // The shell gets to the first key only now; its request is gone, so the answer names none.
    subject.handleEvent({ type: 'line', request: undefined, line: { buffer: 'old', cursor: 3 } });
    subject.handleEvent({ type: 'line', request: requests[1], line: { buffer: 'new', cursor: 1 } });
    assert.deepEqual(await second, { buffer: 'new', cursor: 1 }, 'the second capture gets its own answer');
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.deepEqual(requests, [1, 2]);
    assert.deepEqual(lines, ['set 3 3\nold'], 'the late line is put back');

    // A repeat of an answer already taken is not a line the user lost.
    subject.handleEvent({ type: 'line', request: requests[1], line: { buffer: 'new', cursor: 1 } });
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(lines.length, 1);
  });

  it('notes Enter right after a paste, and only outside it', () => {
    const subject = create(['capture', 'set']);
    subject.filterInput('\u001b[200~echo one\r\n');
    subject.filterInput('echo two\n\u001b[201~');
    assert.equal(subject.isAtPrompt, true, 'newlines in a paste split across chunks are text');
    subject.filterInput('\u001b[200~ls\u001b[201~\r');
    assert.equal(subject.isAtPrompt, false, 'Enter after the paste starts a command');
  });

  it('reports nothing it cannot do', () => {
    const subject = create([]);
    assert.equal(subject.canCapture, false);
    assert.equal(subject.canReplace, false);
    assert.equal(subject.redraw(), false);
  });
});
