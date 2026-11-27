import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { sanitizeTerminalText, stripCellControls } from './sanitize.js';

describe('sanitizeTerminalText', () => {
  it('removes whole escape sequences, payload included', () => {
    assert.equal(sanitizeTerminalText('a\u001b]52;c;ZXZpbA==\u0007b'), 'ab');
    assert.equal(sanitizeTerminalText('a\u001b]0;title\u001b\\b'), 'ab');
    assert.equal(sanitizeTerminalText('a\u001b[2J\u001b[1;31mb\u001b[0m'), 'ab');
    assert.equal(sanitizeTerminalText('a\u009b6n\u009d0;x\u009cb'), 'ab');
    assert.equal(sanitizeTerminalText('a\u001bP+q544e\u001b\\b\u001b_apc\u001b\\c'), 'abc');
    assert.equal(sanitizeTerminalText('\u001b]8;;https://evil.example\u0007label\u001b]8;;\u0007'), 'label');
    assert.equal(sanitizeTerminalText('a\u001b7b\u001b(Bc\u001b'), 'abc');
  });

  it('drops an unterminated string introducer, leaving harmless text', () => {
    assert.equal(sanitizeTerminalText('a\u001b]0;never ends'), 'a0;never ends');
  });

  it('removes control characters and bidi overrides, keeping markdown, tabs and newlines', () => {
    const markdown = '# Title\n\n- **bold** `code` [link](https://x.example)\n\n| a | b |\n|---|---|\n\tindented';
    assert.equal(sanitizeTerminalText(markdown), markdown);
    assert.equal(sanitizeTerminalText('a\u0007\u0008\u000b\u000c\u007f\u0085b\r\nc'), 'ab\nc');
    assert.equal(sanitizeTerminalText('file\u202egnp.exe\u2066x\u2069'), 'filegnp.exex');
    assert.equal(sanitizeTerminalText('漢字 🚀 é'), '漢字 🚀 é');
  });

  it('turns newlines and tabs into spaces when asked', () => {
    assert.equal(sanitizeTerminalText('a\nb\tc', { newlines: false, tabs: false }), 'a b c');
  });
});

describe('stripCellControls', () => {
  it('leaves nothing a terminal would act on', () => {
    assert.equal(stripCellControls('a\u001b\u0007\t\n\u009b\u202eb'), 'ab');
  });
});

describe('sanitizeTerminalText on hostile input', () => {
  // Each unterminated introducer used to scan to the end of the text: 80 KB took about 6 s.
  for (const [label, introducer] of [['C1 DCS', '\u0090'], ['C1 OSC', '\u009d'], ['C1 APC', '\u009f'], ['ESC ]', '\u001b]'], ['ESC P', '\u001bP']] as const) {
    it(`stays linear on 40,000 unterminated ${label} introducers`, () => {
      const hostile = `${introducer}x`.repeat(40_000);
      const started = performance.now();
      const clean = sanitizeTerminalText(hostile);
      const elapsed = performance.now() - started;
      assert.ok(elapsed < 150, `${elapsed.toFixed(0)} ms`);
      assert.ok(!/[\u001b\u0080-\u009f]/.test(clean));
    });
  }

  it('still removes a long but terminated payload whole, up to 4096 characters', () => {
    assert.equal(sanitizeTerminalText(`a\u001b]52;c;${'Q'.repeat(4000)}\u0007b`), 'ab');
  });

  it('removes bidi marks (LRM, RLM, ALM) too', () => {
    assert.equal(sanitizeTerminalText('a‎b‏c؜d'), 'abcd');
  });
});
