import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_COLOR, detectColorDepth, isBlankStyle, rgbToAnsi256, styleToSgr } from './sgr.js';

describe('styleToSgr', () => {
  it('keeps the terminal default colours when none are set', () => {
    assert.equal(styleToSgr({ fg: DEFAULT_COLOR, bg: DEFAULT_COLOR, attributes: 0 }, 'truecolor'), '\u001b[0m');
  });

  it('uses palette codes for indexed colours', () => {
    const style = { fg: { kind: 'indexed', index: 5 }, bg: { kind: 'indexed', index: 8 }, attributes: 1 } as const;
    assert.equal(styleToSgr(style, 'truecolor'), '\u001b[0;1;35;100m');
  });

  it('encodes RGB as 24-bit or the nearest 256-colour entry', () => {
    const style = { fg: { kind: 'rgb', r: 255, g: 0, b: 0 }, bg: DEFAULT_COLOR, attributes: 0 } as const;
    assert.equal(styleToSgr(style, 'truecolor'), '\u001b[0;38;2;255;0;0m');
    assert.equal(styleToSgr(style, 'ansi256'), '\u001b[0;38;5;196m');
  });
});

describe('rgbToAnsi256', () => {
  it('maps greys onto the grey ramp', () => {
    assert.equal(rgbToAnsi256(0, 0, 0), 16);
    assert.equal(rgbToAnsi256(128, 128, 128), 244);
    assert.equal(rgbToAnsi256(255, 255, 255), 231);
  });
});

describe('detectColorDepth', () => {
  it('trusts COLORTERM', () => {
    assert.equal(detectColorDepth({ COLORTERM: 'truecolor' }), 'truecolor');
    assert.equal(detectColorDepth({ TERM_PROGRAM: 'Apple_Terminal' }), 'ansi256');
  });
});

describe('isBlankStyle', () => {
  it('treats underlined or inverse cells as visible', () => {
    assert.equal(isBlankStyle({ fg: DEFAULT_COLOR, bg: DEFAULT_COLOR, attributes: 1 }), true);
    assert.equal(isBlankStyle({ fg: DEFAULT_COLOR, bg: DEFAULT_COLOR, attributes: 8 }), false);
    assert.equal(isBlankStyle({ fg: DEFAULT_COLOR, bg: { kind: 'indexed', index: 1 }, attributes: 0 }), false);
  });
});
