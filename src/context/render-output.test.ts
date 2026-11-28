import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MAX_EMULATED_LINES, renderOutput, renderTerminalText } from './render-output.js';

const ZSH_NO_NEWLINE_MARK = `\u001b[1m\u001b[7m%\u001b[27m\u001b[1m\u001b[0m${' '.repeat(79)}\r \r`;
const plain = (head: string) => ({ head, tail: '', omittedChars: 0, usedFullScreen: false });

describe('renderTerminalText', () => {
  it('strips colors and other escape sequences from plain output', async () => {
    const raw = '\u001b[32m✓\u001b[0m passed \u001b]8;;https://x.test\u0007link\u001b]8;;\u0007\r\n\u001b(Bdone  \r\n\r\n';
    assert.equal(await renderTerminalText(raw, 80), '✓ passed link\ndone');
  });

  it('resolves carriage-return progress bars to their final state', async () => {
    const raw = 'Downloading\r\n 10%\r 50%\r100%\u001b[K\r\nok\r\n';
    assert.equal(await renderTerminalText(raw, 80), 'Downloading\n100%\nok');
  });

  it('returns to the start of the wrapped row, as a terminal does', async () => {
    assert.equal(await renderTerminalText(`${'x'.repeat(25)}\rAB\r\n`, 20), `${'x'.repeat(20)}ABxxx`);
  });

  it('follows tabs, column moves and erases within a line', async () => {
    assert.equal(await renderTerminalText('a\tb\r\n12345\u001b[3G\u001b[KX\r\nab\u0008c\r\n', 80), 'a       b\n12X\nac');
  });

  it('treats a lone carriage return at the end as harmless', async () => {
    assert.equal(await renderTerminalText('1\r\n2\r', 80), '1\n2');
  });

  it('applies cursor movement, as when a tool rewrites earlier lines', async () => {
    const raw = 'step 1: pending\r\nstep 2: pending\r\n\u001b[2A\r\u001b[Kstep 1: done\r\n\u001b[Kstep 2: done\r\n';
    assert.equal(await renderTerminalText(raw, 80), 'step 1: done\nstep 2: done');
  });

  it('replays at most MAX_EMULATED_LINES lines, keeping the end', async () => {
    const lines = Array.from({ length: 3 * MAX_EMULATED_LINES }, (_, index) => `line ${index + 1}`);
    // The cursor move sends it through the emulator; it rewrites the last line.
    const raw = `${lines.join('\r\n')}\r\n\u001b[1A\r\u001b[Klast, rewritten\r\n`;
    const rendered = (await renderTerminalText(raw, 80)).split('\n');
    assert.ok(rendered.length <= MAX_EMULATED_LINES + 24, `${rendered.length} lines`);
    assert.equal(rendered.at(-1), 'last, rewritten');
    assert.equal(rendered.at(-2), `line ${lines.length - 1}`);
    assert.ok(!rendered.includes('line 1'));
  });

  it('rejoins lines the terminal wrapped', async () => {
    const long = 'x'.repeat(50);
    assert.equal(await renderTerminalText(`${long}\r\nnext\r\u001b[K\r\nend`, 20), `${long}\n\nend`);
  });
});

describe('renderOutput', () => {
  it("removes zsh's no-trailing-newline marker but keeps the output", async () => {
    assert.equal(await renderOutput(plain(`a\r\nb${ZSH_NO_NEWLINE_MARK}`), 80), 'a\nb');
    assert.equal(await renderOutput(plain(`done\r\n${ZSH_NO_NEWLINE_MARK}`), 80), 'done');
  });

  it('marks where long output was cut, dropping the partial line on each side', async () => {
    const snapshot = { head: 'first\r\nhalf a li', tail: 'ne\r\nlast\r\n', omittedChars: 12_345, usedFullScreen: false };
    assert.equal(await renderOutput(snapshot, 80), 'first\n[… 12,345 characters of output omitted …]\nlast');
  });

  it('keeps the end of one huge line instead of dropping it at the cut', async () => {
    const snapshot = { head: 'x'.repeat(5000), tail: `${'x'.repeat(5000)}END\r\n`, omittedChars: 99, usedFullScreen: false };
    assert.ok((await renderOutput(snapshot, 80)).endsWith('xEND'));
  });

  it('finds the zsh marker after a title set by precmd()', async () => {
    assert.equal(await renderOutput(plain(`partial${ZSH_NO_NEWLINE_MARK}\u001b]0;~/repo\u0007`), 80), 'partial');
  });

  it('stays fast on long runs that could make a pattern backtrack', async () => {
    const started = performance.now();
    for (const run of [' '.repeat(64_000), 'a.'.repeat(32_000), '1.2.3.'.repeat(10_000)]) {
      await renderOutput(plain(run), 80);
    }
    assert.ok(performance.now() - started < 500, `took ${Math.round(performance.now() - started)}ms`);
  });
});
