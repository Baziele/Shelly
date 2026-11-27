import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { renderOutput, renderTerminalText } from './render-output.js';

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

  it('applies cursor movement, as when a tool rewrites earlier lines', async () => {
    const raw = 'step 1: pending\r\nstep 2: pending\r\n\u001b[2A\r\u001b[Kstep 1: done\r\n\u001b[Kstep 2: done\r\n';
    assert.equal(await renderTerminalText(raw, 80), 'step 1: done\nstep 2: done');
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

  it('marks where long output was cut', async () => {
    const text = await renderOutput({ head: 'first\r\n', tail: 'last\r\n', omittedChars: 12_345, usedFullScreen: false }, 80);
    assert.equal(text, 'first\n[… 12,345 characters of output omitted …]\nlast');
  });
});
