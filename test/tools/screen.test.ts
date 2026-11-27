import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import xterm from '@xterm/headless';
import { decodePng, pixelAt } from './png.js';
import { DEFAULT_THEME, flush, pngRoute, readGrid, renderHtml, renderPng, renderSize, renderSvg, screenLines, screenText, writeScreenshot } from './screen.js';
import { useModernWidths } from './unicode.js';

const CSI = '\u001b[';

/** A screen exercising every attribute the renderer handles. Set SCREEN_TEST_OUT=dir to keep the images. */
const SAMPLE = [
  `plain ${CSI}1mbold${CSI}0m ${CSI}2mdim${CSI}0m ${CSI}3mitalic${CSI}0m ${CSI}4munder${CSI}0m ${CSI}7minverse${CSI}0m ${CSI}9mstrike${CSI}0m`,
  `${CSI}41m red ${CSI}0m ${CSI}48;5;27m 256 ${CSI}0m ${CSI}48;2;255;128;0m rgb ${CSI}0m ${CSI}38;2;0;200;100mgreen text${CSI}0m ${CSI}1;31mbright${CSI}0m`,
  'wide: 中文 🙂 done',
  '╭──────╮ ┌─┬─┐ █▀▄',
  '│ box  │ ├─┼─┤ ░▒▓',
  '╰──────╯ └─┴─┘',
  '$ typed',
].join('\r\n');

const terminalWith = async (text: string, cols = 44, rows = 8): Promise<xterm.Terminal> => {
  const terminal = new xterm.Terminal({ cols, rows, allowProposedApi: true });
  useModernWidths(terminal);
  terminal.write(text);
  await flush(terminal);
  return terminal;
};

const keep = process.env.SCREEN_TEST_OUT;
const outDir = keep ?? mkdtempSync(join(tmpdir(), 'shelly-screen-test-'));
mkdirSync(outDir, { recursive: true });
after(() => {
  if (!keep) {
    rmSync(outDir, { recursive: true, force: true });
  }
});

describe('screen snapshots', () => {
  it('reads the visible screen as text, with an optional cursor marker', async () => {
    const terminal = await terminalWith(SAMPLE);
    assert.deepEqual(screenLines(terminal), [
      'plain bold dim italic under inverse strike',
      ' red   256   rgb  green text bright',
      'wide: 中文 🙂 done',
      '╭──────╮ ┌─┬─┐ █▀▄',
      '│ box  │ ├─┼─┤ ░▒▓',
      '╰──────╯ └─┴─┘',
      '$ typed',
      '',
    ]);
    assert.equal(screenLines(terminal, { cursor: true })[6], '$ typed▮');
    assert.equal(screenText(terminal, { cursor: true, cursorMarker: '|' }).split('\n')[6], '$ typed|');
  });

  it('places the cursor marker by column, past wide characters and trailing space', async () => {
    const terminal = await terminalWith(`中文 x${CSI}1;3H`);
    assert.equal(screenLines(terminal, { cursor: true })[0], '中▮文 x');
    const blank = await terminalWith(`ab${CSI}1;6H`);
    assert.equal(screenLines(blank, { cursor: true })[0], 'ab   ▮');
  });

  it('includes the scrollback on request, and hides a hidden cursor', async () => {
    const terminal = await terminalWith(`${Array.from({ length: 6 }, (_, i) => `line ${i}`).join('\r\n')}${CSI}?25l`, 20, 3);
    assert.deepEqual(screenLines(terminal), ['line 3', 'line 4', 'line 5']);
    assert.deepEqual(screenLines(terminal, { scrollback: true }).slice(0, 2), ['line 0', 'line 1']);
    assert.equal(screenLines(terminal, { cursorMarker: '|' })[2], 'line 5', 'no marker unless asked');
    assert.ok(!renderSvg(terminal).includes(DEFAULT_THEME.cursor), 'a hidden cursor is not drawn');
  });

  it('resolves colours and attributes per cell', async () => {
    const terminal = await terminalWith(SAMPLE);
    const grid = readGrid(terminal);
    const at = (row: number, col: number) => grid.rows[row]!.find((cell) => cell.col === col)!;
    assert.equal(at(1, 1).bg, DEFAULT_THEME.ansi[1]);
    assert.equal(at(1, 7).bg, '#005fff', '256-colour cube');
    assert.equal(at(1, 13).bg, '#ff8000', 'truecolor');
    assert.equal(at(1, 18).fg, '#00c864');
    assert.equal(at(1, 29).fg, DEFAULT_THEME.ansi[9], 'bold red is drawn bright');
    assert.ok(at(0, 6).bold && at(0, 15).italic && at(0, 22).underline && at(0, 36).strikethrough);
    assert.equal(at(0, 28).bg, DEFAULT_THEME.foreground, 'inverse swaps colours');
    assert.equal(at(2, 6).width, 2, 'CJK is wide');
    assert.equal(at(2, 11).chars, '🙂');
    assert.equal(at(2, 11).width, 2, 'emoji are wide');
  });

  it('renders SVG and HTML', async () => {
    const terminal = await terminalWith(SAMPLE);
    const svg = renderSvg(terminal);
    assert.match(svg, /^<svg [^>]*width="\d+" height="\d+"/);
    assert.match(svg, /<text [^>]*>中<\/text>/);
    const html = renderHtml(terminal, { title: 'sample' });
    assert.match(html, /<title>sample<\/title>/);
    assert.match(html, /background:#ff8000/);
    assert.match(html, /display:inline-block;width:2ch">🙂/);
  });

  it('writes a PNG that shows the right colours in the right cells', { skip: !pngRoute() && 'no SVG rasteriser here' }, async () => {
    const terminal = await terminalWith(SAMPLE);
    const files = await writeScreenshot(terminal, join(outDir, 'sample'), { extras: true });
    assert.ok(files.png && existsSync(files.png), files.pngError ?? 'no PNG');
    assert.equal(readFileSync(files.txt, 'utf8'), `${screenText(terminal)}\n`);
    assert.ok(files.svg && files.html && existsSync(files.svg) && existsSync(files.html));

    const image = decodePng(readFileSync(files.png));
    const { width, height } = renderSize(terminal);
    assert.equal(image.width, width * 2);
    assert.equal(image.height, height * 2);

    // Default layout: 14px font, 8.4 × 18 px cells, 8 px padding, drawn at 2×.
    const cell = (col: number, row: number): [number, number] => [(8 + (col + 0.5) * 8.4) * 2, (8 + (row + 0.5) * 18) * 2];
    assert.equal(pixelAt(image, 2, 2), DEFAULT_THEME.background);
    // Probe the spaces padding each label, so no glyph is in the way.
    assert.equal(pixelAt(image, ...cell(0, 1)), DEFAULT_THEME.ansi[1]!);
    assert.equal(pixelAt(image, ...cell(6, 1)), '#005fff');
    assert.equal(pixelAt(image, ...cell(12, 1)), '#ff8000');
    assert.equal(pixelAt(image, ...cell(15, 3)), DEFAULT_THEME.foreground, 'full block');
    assert.equal(pixelAt(image, ...cell(7, 6)), DEFAULT_THEME.cursor, 'cursor');

    const png = await renderPng(terminal, { scale: 1 });
    assert.equal(decodePng(png).width, width);
  });
});
