import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { LINE_KEYS, LineEditor } from './line-editor.js';

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
      // "a😀b|c": the shell counts the cursor in characters.
      queueMicrotask(() => subject.handleEvent({ type: 'line', line: { buffer: 'a😀bc', cursor: 3 } }));
    };
    assert.deepEqual(await subject.capture(), { buffer: 'a😀bc', cursor: 4 });
  });

  it('waits for the redraw that follows the answer', async () => {
    const subject = create(['capture']);
    shell = () => queueMicrotask(() => {
      subject.handleEvent({ type: 'line', line: { buffer: 'ls', cursor: 2 } });
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
    subject.handleEvent({ type: 'line', line: { buffer: 'late', cursor: 4 } });
    assert.deepEqual(written, [LINE_KEYS.set]);
    assert.equal(readFileSync(subject.lineFile ?? '', 'utf8'), '4\nlate');
    subject.handleEvent({ type: 'line-set' });
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
      queueMicrotask(() => subject.handleEvent({ type: 'line-set' }));
    };
    await subject.replace("echo '$HOME' \"!!\"\n\tdone 😀");
    await subject.restore({ buffer: 'a😀bc', cursor: 3 });
    assert.deepEqual(seen, [
      { content: "25\necho '$HOME' \"!!\"\n\tdone 😀", mode: 0o600 },
      { content: '2\na😀bc', mode: 0o600 },
    ]);
    assert.ok(!existsSync(file));
  });

  it('removes the file when the shell does not take it', async () => {
    const subject = create(['set'], { timeoutMs: 10 });
    await assert.rejects(subject.replace('ls'), /did not take/);
    assert.ok(!existsSync(subject.lineFile ?? ''));
  });

  it('sends keys for one operation at a time, the first straight away', async () => {
    const subject = create(['capture', 'set']);
    shell = (data) => queueMicrotask(() => subject.handleEvent(
      data === LINE_KEYS.capture ? { type: 'line', line: { buffer: 'x', cursor: 1 } } : { type: 'line-set' },
    ));
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

  it('reports nothing it cannot do', () => {
    const subject = create([]);
    assert.equal(subject.canCapture, false);
    assert.equal(subject.canReplace, false);
    assert.equal(subject.redraw(), false);
  });
});
