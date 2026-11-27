import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type xterm from '@xterm/headless';

/*
 * Pictures of an emulated terminal, for looking at the UI by eye. The screen
 * (or the whole buffer, scrollback included) becomes an SVG drawn with a
 * typical dark palette; on macOS, `qlmanage` turns it into a PNG.
 */

const PALETTE_16 = [
  '#1d1f21', '#cc6666', '#b5bd68', '#f0c674', '#81a2be', '#b294bb', '#8abeb7', '#c5c8c6',
  '#666666', '#d54e53', '#b9ca4a', '#e7c547', '#7aa6da', '#c397d8', '#70c0b1', '#eaeaea',
];
const BACKGROUND = '#1d1f21';
const FOREGROUND = '#c5c8c6';
const CELL_WIDTH = 8.4;
const CELL_HEIGHT = 17;

const palette256 = (index: number): string => {
  if (index < 16) {
    return PALETTE_16[index]!;
  }
  if (index >= 232) {
    const level = 8 + (index - 232) * 10;
    return `rgb(${level},${level},${level})`;
  }
  const cube = index - 16;
  const level = (value: number): number => (value === 0 ? 0 : 55 + value * 40);
  return `rgb(${level(Math.floor(cube / 36))},${level(Math.floor(cube / 6) % 6)},${level(cube % 6)})`;
};

const escapeXml = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

type Cell = NonNullable<ReturnType<NonNullable<ReturnType<xterm.Terminal['buffer']['active']['getLine']>>['getCell']>>;

const colorOf = (cell: Cell, layer: 'fg' | 'bg'): string | undefined => {
  const isDefault = layer === 'fg' ? cell.isFgDefault() : cell.isBgDefault();
  if (isDefault) {
    return undefined;
  }
  const value = layer === 'fg' ? cell.getFgColor() : cell.getBgColor();
  const isRgb = layer === 'fg' ? cell.isFgRGB() : cell.isBgRGB();
  if (isRgb) {
    return `rgb(${(value >> 16) & 255},${(value >> 8) & 255},${value & 255})`;
  }
  return palette256(value);
};

export interface ScreenshotOptions {
  /** `screen`: the visible rows; `all`: scrollback and screen. */
  readonly region?: 'screen' | 'all';
  readonly title?: string;
}

/** The terminal as an SVG document. */
export const terminalSvg = (terminal: xterm.Terminal, options: ScreenshotOptions = {}): string => {
  const buffer = terminal.buffer.active;
  const first = options.region === 'all' ? 0 : buffer.viewportY;
  let last = options.region === 'all' ? buffer.length : buffer.viewportY + terminal.rows;
  if (options.region === 'all') {
    while (last > first + 1 && (buffer.getLine(last - 1)?.translateToString(true) ?? '') === '') {
      last--;
    }
  }
  const titleRows = options.title ? 1.6 : 0;
  const width = Math.ceil(terminal.cols * CELL_WIDTH + 16);
  const height = Math.ceil((last - first + titleRows) * CELL_HEIGHT + 16);
  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<rect width="100%" height="100%" fill="${BACKGROUND}"/>`,
    `<g font-family="Menlo, Monaco, monospace" font-size="14" xml:space="preserve">`,
  ];
  if (options.title) {
    parts.push(`<text x="8" y="${8 + CELL_HEIGHT * 0.8}" fill="#888" font-size="12">${escapeXml(options.title)}</text>`);
  }
  const cursorRow = buffer.baseY + buffer.cursorY;

  for (let row = first; row < last; row++) {
    const line = buffer.getLine(row);
    if (!line) {
      continue;
    }
    const y = 8 + (row - first + titleRows) * CELL_HEIGHT;
    for (let col = 0; col < terminal.cols; col++) {
      const cell = line.getCell(col);
      if (!cell || cell.getWidth() === 0) {
        continue;
      }
      const x = 8 + col * CELL_WIDTH;
      const inverse = Boolean(cell.isInverse());
      let fg = colorOf(cell, 'fg') ?? FOREGROUND;
      let bg = colorOf(cell, 'bg');
      if (inverse) {
        [fg, bg] = [bg ?? BACKGROUND, fg];
      }
      if (bg) {
        parts.push(`<rect x="${x}" y="${y}" width="${CELL_WIDTH * cell.getWidth()}" height="${CELL_HEIGHT}" fill="${bg}"/>`);
      }
      const chars = cell.getChars();
      if (chars && chars !== ' ') {
        const attributes = [
          cell.isBold() ? 'font-weight="bold"' : '',
          cell.isItalic() ? 'font-style="italic"' : '',
          cell.isDim() ? 'opacity="0.55"' : '',
          cell.isUnderline() ? 'text-decoration="underline"' : cell.isStrikethrough() ? 'text-decoration="line-through"' : '',
        ].filter(Boolean).join(' ');
        parts.push(`<text x="${x}" y="${y + CELL_HEIGHT * 0.78}" fill="${fg}" ${attributes}>${escapeXml(chars)}</text>`);
      }
    }
    const cursorHidden = (terminal as unknown as { _core?: { coreService?: { isCursorHidden?: boolean } } })._core?.coreService?.isCursorHidden;
    if (row === cursorRow && !cursorHidden && terminal.buffer.active.cursorX < terminal.cols) {
      parts.push(`<rect x="${8 + buffer.cursorX * CELL_WIDTH}" y="${y}" width="${CELL_WIDTH}" height="${CELL_HEIGHT}" fill="none" stroke="#888"/>`);
    }
  }
  parts.push('</g></svg>');
  return parts.join('\n');
};

const CHROME_PATHS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
];

/**
 * Write the terminal to `path` as SVG, and as PNG next to it when a headless
 * Chrome (or, on macOS, `qlmanage`, which crops to a square) is there.
 * Returns the PNG's path, or the SVG's.
 */
export const saveScreenshot = (terminal: xterm.Terminal, path: string, options: ScreenshotOptions = {}): string => {
  const svgPath = path.replace(/\.png$/, '') + '.svg';
  const pngPath = svgPath.replace(/\.svg$/, '.png');
  mkdirSync(dirname(svgPath), { recursive: true });
  const svg = terminalSvg(terminal, options);
  writeFileSync(svgPath, svg);
  const [, width, height] = /width="(\d+)" height="(\d+)"/.exec(svg) ?? [];

  const chrome = CHROME_PATHS.find((candidate) => existsSync(candidate));
  if (chrome) {
    try {
      execFileSync(chrome, [
        '--headless', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=2',
        `--window-size=${width},${height}`, `--screenshot=${pngPath}`, `file://${svgPath}`,
      ], { stdio: 'ignore', timeout: 20_000 });
      return pngPath;
    } catch {
      // Fall through to qlmanage.
    }
  }
  if (process.platform !== 'darwin') {
    return svgPath;
  }
  try {
    const directory = dirname(svgPath);
    execFileSync('qlmanage', ['-t', '-s', String(Number(width) * 2), '-o', directory, svgPath], { stdio: 'ignore' });
    renameSync(join(directory, `${basename(svgPath)}.png`), pngPath);
    return pngPath;
  } catch {
    return svgPath;
  }
};
