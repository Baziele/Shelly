import assert from 'node:assert/strict';
import { it } from 'node:test';
import { sanitizeTerminalText } from '../../src/render/sanitize.js';

for (const [label, ch] of [['C1 DCS U+0090', '\u0090'], ['C1 OSC U+009D', '\u009d'], ['ESC ] (7-bit OSC)', '\u001b]']] as const) {
  it(`sanitizing 40,000 unterminated ${label} introducers is linear`, () => {
    const hostile = (ch + 'x').repeat(40_000);
    const t = performance.now();
    sanitizeTerminalText(hostile);
    const ms = performance.now() - t;
    console.log(`${label}: ${ms.toFixed(0)} ms for ${hostile.length} chars`);
    assert.ok(ms < 100, `${ms.toFixed(0)} ms`);
  });
}
