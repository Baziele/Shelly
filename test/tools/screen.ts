import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { promisify } from 'node:util';
import type { IBufferCell, Terminal } from '@xterm/headless';
import { cropImage, decodePng, encodePng } from './png.js';

/*
 * Turns what an @xterm/headless terminal shows into text, SVG, HTML or PNG.
 *
 * Everything is drawn on a fixed cell grid: one text cell is `cellWidth` by
 * `cellHeight` pixels, wide characters take two, and box-drawing and block
 * characters are drawn as shapes so borders join up whatever the font.
 *
 * PNG route: the SVG is rasterised by macOS Quick Look (`qlmanage -t`), which
 * renders it with WebKit and the system fonts (so CJK and colour emoji work),
 * then cropped out of Quick Look's square thumbnail. Elsewhere `rsvg-convert`
 * is used when it is on PATH; with neither, `writeScreenshot` writes the SVG
 * and HTML and says so.
 */

export interface ScreenTheme {
  readonly background: string;
  readonly foreground: string;
  readonly cursor: string;
  /** The 16 ANSI colours: black, red, green, yellow, blue, magenta, cyan, white, then the bright ones. */
  readonly ansi: readonly string[];
}

/** xterm.js's default palette on a dark background. */
export const DEFAULT_THEME: ScreenTheme = {
  background: '#1e1e1e',
  foreground: '#d4d4d4',
  cursor: '#e8e8e8',
  ansi: [
    '#2e3436', '#cc0000', '#4e9a06', '#c4a000', '#3465a4', '#75507b', '#06989a', '#d3d7cf',
    '#555753', '#ef2929', '#8ae234', '#fce94f', '#729fcf', '#ad7fa8', '#34e2e2', '#eeeeec',
  ],
};

export interface ScreenOptions {
  /** Include the scrollback above the visible screen. */
  readonly scrollback?: boolean;
  /**
   * Show the cursor. `true` always, `false` never; by default it is shown
   * unless the application hid it (DECTCEM). In text it is a marker string.
   */
  readonly cursor?: boolean;
}

export interface TextOptions extends ScreenOptions {
  /** Inserted at the cursor column when the cursor is shown. Default `▮`. */
  readonly cursorMarker?: string;
}

export interface RenderOptions extends ScreenOptions {
  readonly theme?: ScreenTheme;
  /** Font size in CSS pixels. Default 14. */
  readonly fontSize?: number;
  /** Margin around the grid in pixels. Default 8. */
  readonly padding?: number;
  /** Draw bold text in the bright variant of colours 0–7, as xterm.js does. Default true. */
  readonly boldIsBright?: boolean;
  /** Shown as the page title in HTML. */
  readonly title?: string;
}

export interface PngOptions extends RenderOptions {
  /** Device pixels per CSS pixel. Default 2. */
  readonly scale?: number;
}

/** One cell, colours resolved. Wide characters are one cell of width 2 followed by nothing. */
export interface ScreenCell {
  readonly col: number;
  readonly chars: string;
  readonly width: 1 | 2;
  readonly fg: string;
  readonly bg: string;
  /** Whether the background differs from the terminal's default. */
  readonly hasBg: boolean;
  readonly bold: boolean;
  readonly dim: boolean;
  readonly italic: boolean;
  readonly underline: boolean;
  readonly strikethrough: boolean;
  readonly overline: boolean;
  readonly invisible: boolean;
  readonly inverse: boolean;
}

export interface ScreenGrid {
  readonly cols: number;
  readonly rows: ScreenCell[][];
  /** Cursor position within `rows`, when it is shown and on them. */
  readonly cursor: { readonly row: number; readonly col: number } | undefined;
  readonly theme: ScreenTheme;
}

/** Resolves once everything written to the terminal so far has been parsed. */
export const flush = (terminal: Terminal): Promise<void> => new Promise((resolve) => terminal.write('', resolve));

const cursorHidden = (terminal: Terminal): boolean => {
  // Not public in @xterm/headless; fall back to "visible" if the internals move.
  const core = (terminal as unknown as { _core?: { coreService?: { isCursorHidden?: boolean } } })._core;
  return core?.coreService?.isCursorHidden === true;
};

/** Rows to show (absolute buffer indexes) and where the cursor sits among them. */
const visibleRange = (terminal: Terminal, options: ScreenOptions) => {
  const buffer = terminal.buffer.active;
  const first = options.scrollback ? 0 : buffer.viewportY;
  const last = buffer.viewportY + terminal.rows;
  const show = options.cursor ?? !cursorHidden(terminal);
  const cursorRow = buffer.baseY + buffer.cursorY - first;
  const cursor = show && cursorRow >= 0 && cursorRow < last - first
    ? { row: cursorRow, col: Math.min(buffer.cursorX, terminal.cols - 1) }
    : undefined;
  return { first, last, cursor };
};

/** The screen as lines of text, wide characters once, trailing spaces trimmed. */
export const screenLines = (terminal: Terminal, options: TextOptions = {}): string[] => {
  const buffer = terminal.buffer.active;
  const { first, last, cursor } = visibleRange(terminal, options);
  const marker = options.cursorMarker ?? '▮';
  const cell = buffer.getNullCell();
  const lines: string[] = [];
  for (let y = first; y < last; y++) {
    const line = buffer.getLine(y);
    const cursorCol = cursor && cursor.row === y - first ? cursor.col : -1;
    let text = '';
    let pending = '';
    for (let x = 0; x < terminal.cols; x++) {
      if (x === cursorCol) {
        text += pending + marker;
        pending = '';
      }
      const current = line?.getCell(x, cell);
      if (!current || current.getWidth() === 0) {
        continue;
      }
      const chars = current.getChars();
      if (chars === '' || chars === ' ') {
        pending += ' ';
      } else {
        text += pending + chars;
        pending = '';
      }
    }
    lines.push(text);
  }
  return lines;
};

/** The screen as one string; see `screenLines`. */
export const screenText = (terminal: Terminal, options: TextOptions = {}): string =>
  screenLines(terminal, options).join('\n');

const cubeLevels = [0, 95, 135, 175, 215, 255];
const hex = (r: number, g: number, b: number): string =>
  `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;

const paletteColor = (index: number, theme: ScreenTheme): string => {
  if (index < 16) {
    return theme.ansi[index] ?? theme.foreground;
  }
  if (index < 232) {
    const i = index - 16;
    return hex(cubeLevels[Math.floor(i / 36)]!, cubeLevels[Math.floor(i / 6) % 6]!, cubeLevels[i % 6]!);
  }
  const level = 8 + (index - 232) * 10;
  return hex(level, level, level);
};

const mix = (a: string, b: string, amount: number): string => {
  const parse = (c: string) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
  const [ar, ag, ab] = parse(a);
  const [br, bg, bb] = parse(b);
  return hex(ar! + (br! - ar!) * amount, ag! + (bg! - ag!) * amount, ab! + (bb! - ab!) * amount);
};

const resolveCell = (cell: IBufferCell, col: number, theme: ScreenTheme, boldIsBright: boolean): ScreenCell => {
  const bold = cell.isBold() !== 0;
  let fg = theme.foreground;
  if (cell.isFgRGB()) {
    const c = cell.getFgColor();
    fg = hex(c >> 16 & 0xff, c >> 8 & 0xff, c & 0xff);
  } else if (cell.isFgPalette()) {
    const index = cell.getFgColor();
    fg = paletteColor(bold && boldIsBright && index < 8 ? index + 8 : index, theme);
  }
  let bg = theme.background;
  if (cell.isBgRGB()) {
    const c = cell.getBgColor();
    bg = hex(c >> 16 & 0xff, c >> 8 & 0xff, c & 0xff);
  } else if (cell.isBgPalette()) {
    bg = paletteColor(cell.getBgColor(), theme);
  }
  const inverse = cell.isInverse() !== 0;
  if (inverse) {
    [fg, bg] = [bg, fg];
  }
  const dim = cell.isDim() !== 0;
  if (dim) {
    fg = mix(fg, bg, 0.5);
  }
  return {
    col,
    chars: cell.getChars(),
    width: cell.getWidth() === 2 ? 2 : 1,
    fg,
    bg,
    hasBg: inverse || !cell.isBgDefault(),
    bold,
    dim,
    italic: cell.isItalic() !== 0,
    underline: cell.isUnderline() !== 0,
    strikethrough: cell.isStrikethrough() !== 0,
    overline: cell.isOverline() !== 0,
    invisible: cell.isInvisible() !== 0,
    inverse,
  };
};

/** The screen as cells with resolved colours, for rendering or for asserting styles in tests. */
export const readGrid = (terminal: Terminal, options: RenderOptions = {}): ScreenGrid => {
  const theme = options.theme ?? DEFAULT_THEME;
  const boldIsBright = options.boldIsBright ?? true;
  const buffer = terminal.buffer.active;
  const { first, last, cursor } = visibleRange(terminal, options);
  const scratch = buffer.getNullCell();
  const rows: ScreenCell[][] = [];
  for (let y = first; y < last; y++) {
    const line = buffer.getLine(y);
    const row: ScreenCell[] = [];
    for (let x = 0; x < terminal.cols; x++) {
      const cell = line?.getCell(x, scratch);
      if (cell && cell.getWidth() !== 0) {
        row.push(resolveCell(cell, x, theme, boldIsBright));
      }
    }
    rows.push(row);
  }
  return { cols: terminal.cols, rows, cursor, theme };
};

const escapeXml = (text: string): string =>
  text.replace(/[&<>"']/g, (c) => `&${{ '&': 'amp', '<': 'lt', '>': 'gt', '"': 'quot', "'": 'apos' }[c]};`);

const FONT_FAMILY = `Menlo, 'SF Mono', Monaco, 'DejaVu Sans Mono', 'Liberation Mono', monospace`;

interface Metrics {
  readonly fontSize: number;
  readonly cellWidth: number;
  readonly cellHeight: number;
  /** Baseline offset from the top of a cell. */
  readonly baseline: number;
  readonly padding: number;
  readonly width: number;
  readonly height: number;
}

const metrics = (grid: ScreenGrid, options: RenderOptions): Metrics => {
  const fontSize = options.fontSize ?? 14;
  const padding = options.padding ?? 8;
  const cellWidth = Math.round(fontSize * 0.6 * 100) / 100;
  const cellHeight = Math.round(fontSize * 1.25);
  return {
    fontSize,
    cellWidth,
    cellHeight,
    baseline: Math.round(cellHeight * 0.5 + fontSize * 0.36),
    padding,
    width: Math.ceil(padding * 2 + grid.cols * cellWidth),
    height: padding * 2 + grid.rows.length * cellHeight,
  };
};

/*
 * Box drawing: arms up, right, down, left; 1 light, 2 heavy, 3 double.
 * Anything not listed is left to the font.
 */
const BOX: Record<string, string> = {};
const defineBox = (chars: string, weight: number, shapes: readonly string[]): void => {
  [...chars].forEach((char, i) => {
    BOX[char] = shapes[i]!.replace(/1/g, String(weight));
  });
};
const BOX_SHAPES = ['0101', '1010', '0110', '0011', '1100', '1001', '1110', '1011', '0111', '1101', '1111'];
defineBox('─│┌┐└┘├┤┬┴┼', 1, BOX_SHAPES);
defineBox('━┃┏┓┗┛┣┫┳┻╋', 2, BOX_SHAPES);
defineBox('═║╔╗╚╝╠╣╦╩╬', 3, BOX_SHAPES);
defineBox('╴╵╶╷', 1, ['0001', '1000', '0100', '0010']);
defineBox('╸╹╺╻', 2, ['0001', '1000', '0100', '0010']);
const ROUNDED: Record<string, readonly [number, number]> = { '╭': [1, 2], '╮': [2, 3], '╯': [0, 3], '╰': [0, 1] };

/** Fractions of the cell [x, y, w, h] and an opacity, for block elements. */
const BLOCKS: Record<string, readonly [number, number, number, number, number?]> = {
  '█': [0, 0, 1, 1], '▀': [0, 0, 1, 0.5], '▄': [0, 0.5, 1, 0.5], '▌': [0, 0, 0.5, 1], '▐': [0.5, 0, 0.5, 1],
  '▔': [0, 0, 1, 0.125], '▕': [0.875, 0, 0.125, 1],
  '░': [0, 0, 1, 1, 0.25], '▒': [0, 0, 1, 1, 0.5], '▓': [0, 0, 1, 1, 0.75],
  '▖': [0, 0.5, 0.5, 0.5], '▗': [0.5, 0.5, 0.5, 0.5], '▘': [0, 0, 0.5, 0.5], '▝': [0.5, 0, 0.5, 0.5],
};
for (let n = 1; n <= 7; n++) {
  BLOCKS[String.fromCodePoint(0x2580 + n)] = [0, 1 - n / 8, 1, n / 8]; // ▁ … ▇
  BLOCKS[String.fromCodePoint(0x2590 - n)] = [0, 0, n / 8, 1]; // ▏ … ▉
}

const DIRS = [[0, -1], [1, 0], [0, 1], [-1, 0]] as const;

const drawBox = (shape: string, x: number, y: number, m: Metrics, color: string): string => {
  const thin = Math.max(1, Math.round(m.fontSize / 14));
  const cx = x + m.cellWidth / 2;
  const cy = y + m.cellHeight / 2;
  const arms = [...shape].map(Number);
  const rect = (x0: number, y0: number, x1: number, y1: number): string =>
    `<rect x="${Math.min(x0, x1).toFixed(2)}" y="${Math.min(y0, y1).toFixed(2)}" width="${Math.abs(x1 - x0).toFixed(2)}" height="${Math.abs(y1 - y0).toFixed(2)}" fill="${color}"/>`;
  // Distance from the centre to the cell edge in direction d.
  const reach = (d: number): number => (d % 2 === 0 ? m.cellHeight : m.cellWidth) / 2;
  // A line along direction d, offset sideways by `side`, from `start` (along d) to the edge.
  const line = (d: number, side: number, start: number, width: number): string => {
    const [dx, dy] = DIRS[d]!;
    const end = reach(d);
    if (dx === 0) {
      return rect(cx + side - width / 2, cy + dy * start, cx + side + width / 2, cy + dy * end);
    }
    return rect(cx + dx * start, cy + side - width / 2, cx + dx * end, cy + side + width / 2);
  };
  let out = '';
  arms.forEach((weight, d) => {
    if (weight === 1 || weight === 2) {
      const width = weight * thin;
      out += line(d, 0, -width / 2, width);
    } else if (weight === 3) {
      const gap = thin * 1.5;
      // Each of the two lines stops short where a side arm meets it, runs to the centre
      // when the line continues straight on, and otherwise turns the outer corner.
      for (const sign of [-1, 1]) {
        const sideDir = d % 2 === 0 ? (sign < 0 ? 3 : 1) : (sign < 0 ? 0 : 2);
        const start = arms[sideDir] ? gap - thin / 2 : arms[(d + 2) % 4] ? 0 : -gap - thin / 2;
        out += line(d, sign * gap, start, thin);
      }
    }
  });
  return out;
};

const drawRounded = ([a, b]: readonly [number, number], x: number, y: number, m: Metrics, color: string): string => {
  const thin = Math.max(1, Math.round(m.fontSize / 14));
  const cx = x + m.cellWidth / 2;
  const cy = y + m.cellHeight / 2;
  const r = Math.min(m.cellWidth, m.cellHeight) / 2;
  const edge = (d: number): [number, number] => {
    const [dx, dy] = DIRS[d]!;
    return [cx + dx * (dx ? m.cellWidth / 2 : 0), cy + dy * (dy ? m.cellHeight / 2 : 0)];
  };
  const near = (d: number): [number, number] => [cx + DIRS[d]![0] * r, cy + DIRS[d]![1] * r];
  const [ax, ay] = edge(a);
  const [bx, by] = edge(b);
  const [p, q] = [near(a), near(b)];
  return `<path d="M${ax.toFixed(2)},${ay.toFixed(2)} L${p[0].toFixed(2)},${p[1].toFixed(2)} Q${cx.toFixed(2)},${cy.toFixed(2)} ${q[0].toFixed(2)},${q[1].toFixed(2)} L${bx.toFixed(2)},${by.toFixed(2)}" fill="none" stroke="${color}" stroke-width="${thin}"/>`;
};

const textAttrs = (cell: ScreenCell): string =>
  `fill="${cell.fg}"${cell.bold ? ' font-weight="bold"' : ''}${cell.italic ? ' font-style="italic"' : ''}`;

const sameText = (a: ScreenCell, b: ScreenCell): boolean =>
  a.fg === b.fg && a.bold === b.bold && a.italic === b.italic;

/** A cell-accurate SVG of the screen. */
export const renderSvg = (terminal: Terminal, options: RenderOptions = {}): string =>
  gridToSvg(readGrid(terminal, options), options);

export const gridToSvg = (grid: ScreenGrid, options: RenderOptions = {}): string => {
  const m = metrics(grid, options);
  const { theme } = grid;
  const backgrounds: string[] = [];
  const shapes: string[] = [];
  const texts: string[] = [];
  const lines: string[] = [];
  const cellX = (col: number): number => m.padding + col * m.cellWidth;

  grid.rows.forEach((row, r) => {
    const top = m.padding + r * m.cellHeight;
    const cursorCol = grid.cursor?.row === r ? grid.cursor.col : -1;
    const cells = row.map((cell) => cell.col === cursorCol
      // A block cursor shows the cell inverted.
      ? { ...cell, fg: theme.background, bg: theme.cursor, hasBg: true }
      : cell);
    if (cursorCol >= 0 && !cells.some((cell) => cell.col === cursorCol)) {
      backgrounds.push(`<rect x="${cellX(cursorCol).toFixed(2)}" y="${top}" width="${m.cellWidth}" height="${m.cellHeight}" fill="${theme.cursor}"/>`);
    }

    // Backgrounds, merged into runs.
    for (let i = 0; i < cells.length;) {
      const start = cells[i]!;
      let end = i;
      while (end + 1 < cells.length && cells[end + 1]!.hasBg === start.hasBg && cells[end + 1]!.bg === start.bg) {
        end++;
      }
      if (start.hasBg) {
        const last = cells[end]!;
        const width = (last.col + last.width - start.col) * m.cellWidth;
        backgrounds.push(`<rect x="${cellX(start.col).toFixed(2)}" y="${top}" width="${width.toFixed(2)}" height="${m.cellHeight}" fill="${start.bg}"/>`);
      }
      i = end + 1;
    }

    // Text: runs of plain narrow characters share one <text> with a position per character.
    let run: ScreenCell[] = [];
    const flushRun = (): void => {
      if (run.length > 0) {
        const xs = run.map((cell) => (cellX(cell.col) + m.cellWidth / 2).toFixed(2)).join(' ');
        texts.push(`<text x="${xs}" y="${top + m.baseline}" ${textAttrs(run[0]!)}>${escapeXml(run.map((cell) => cell.chars).join(''))}</text>`);
        run = [];
      }
    };
    for (const cell of cells) {
      const x = cellX(cell.col);
      if (cell.underline) {
        lines.push(`<rect x="${x.toFixed(2)}" y="${(top + m.baseline + Math.max(1, m.fontSize * 0.12)).toFixed(2)}" width="${(cell.width * m.cellWidth).toFixed(2)}" height="${Math.max(1, Math.round(m.fontSize / 14))}" fill="${cell.fg}"/>`);
      }
      if (cell.strikethrough) {
        lines.push(`<rect x="${x.toFixed(2)}" y="${(top + m.baseline - m.fontSize * 0.3).toFixed(2)}" width="${(cell.width * m.cellWidth).toFixed(2)}" height="${Math.max(1, Math.round(m.fontSize / 14))}" fill="${cell.fg}"/>`);
      }
      if (cell.overline) {
        lines.push(`<rect x="${x.toFixed(2)}" y="${top}" width="${(cell.width * m.cellWidth).toFixed(2)}" height="${Math.max(1, Math.round(m.fontSize / 14))}" fill="${cell.fg}"/>`);
      }
      const chars = cell.chars;
      if (cell.invisible || chars === '' || chars === ' ') {
        flushRun();
        continue;
      }
      const box = BOX[chars];
      const rounded = ROUNDED[chars];
      const block = BLOCKS[chars];
      if (box || rounded || block) {
        flushRun();
        if (box) {
          shapes.push(drawBox(box, x, top, m, cell.fg));
        } else if (rounded) {
          shapes.push(drawRounded(rounded, x, top, m, cell.fg));
        } else if (block) {
          const [bx, by, bw, bh, opacity] = block;
          shapes.push(`<rect x="${(x + bx * m.cellWidth).toFixed(2)}" y="${(top + by * m.cellHeight).toFixed(2)}" width="${(bw * m.cellWidth).toFixed(2)}" height="${(bh * m.cellHeight).toFixed(2)}" fill="${cell.fg}"${opacity ? ` fill-opacity="${opacity}"` : ''}/>`);
        }
        continue;
      }
      if (cell.width === 2 || [...chars].length > 1) {
        // Wide or combined: centred on its own over the cells it covers.
        flushRun();
        texts.push(`<text x="${(x + (cell.width * m.cellWidth) / 2).toFixed(2)}" y="${top + m.baseline}" ${textAttrs(cell)}>${escapeXml(chars)}</text>`);
        continue;
      }
      if (run.length > 0 && !sameText(run[0]!, cell)) {
        flushRun();
      }
      run.push(cell);
    }
    flushRun();
  });

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${m.width}" height="${m.height}" viewBox="0 0 ${m.width} ${m.height}">`,
    `<rect width="100%" height="100%" fill="${theme.background}"/>`,
    ...backgrounds,
    `<g shape-rendering="crispEdges">`, ...shapes, ...lines, `</g>`,
    `<g font-family="${FONT_FAMILY}" font-size="${m.fontSize}" text-anchor="middle">`, ...texts, `</g>`,
    `</svg>`,
    '',
  ].join('\n');
};

const escapeHtml = escapeXml;

/** A self-contained HTML page: real, selectable text on the same cell grid. */
export const renderHtml = (terminal: Terminal, options: RenderOptions = {}): string =>
  gridToHtml(readGrid(terminal, options), options);

export const gridToHtml = (grid: ScreenGrid, options: RenderOptions = {}): string => {
  const m = metrics(grid, options);
  const { theme } = grid;
  const rows = grid.rows.map((row, r) => {
    const cursorCol = grid.cursor?.row === r ? grid.cursor.col : -1;
    let html = '';
    let col = 0;
    for (const cell of row) {
      while (col < cell.col) {
        html += col === cursorCol ? '<span class="cursor"> </span>' : ' ';
        col++;
      }
      const cursor = cell.col === cursorCol;
      const styles = [
        `color:${cursor ? theme.background : cell.fg}`,
        cursor ? `background:${theme.cursor}` : cell.hasBg ? `background:${cell.bg}` : '',
        cell.bold ? 'font-weight:bold' : '',
        cell.italic ? 'font-style:italic' : '',
        [cell.underline && 'underline', cell.strikethrough && 'line-through', cell.overline && 'overline'].filter(Boolean).length
          ? `text-decoration:${[cell.underline && 'underline', cell.strikethrough && 'line-through', cell.overline && 'overline'].filter(Boolean).join(' ')}`
          : '',
        cell.invisible ? 'visibility:hidden' : '',
        cell.width === 2 ? 'display:inline-block;width:2ch' : '',
      ].filter(Boolean).join(';');
      const chars = cell.chars === '' ? ' ' : cell.chars;
      html += styles === `color:${theme.foreground}` ? escapeHtml(chars) : `<span style="${styles}">${escapeHtml(chars)}</span>`;
      col += cell.width;
    }
    if (cursorCol >= col) {
      html += ' '.repeat(cursorCol - col) + '<span class="cursor"> </span>';
    }
    return `<div class="row">${html}</div>`;
  });
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${escapeHtml(options.title ?? 'Terminal')}</title>
<style>
body { margin: 0; background: ${theme.background}; }
.screen { display: inline-block; padding: ${m.padding}px; background: ${theme.background}; color: ${theme.foreground};
  font: ${m.fontSize}px/${m.cellHeight}px ${FONT_FAMILY}; white-space: pre; }
.row { height: ${m.cellHeight}px; }
.cursor { background: ${theme.cursor}; color: ${theme.background}; }
</style></head>
<body><div class="screen">
${rows.join('\n')}
</div></body></html>
`;
};

export type PngRoute = 'qlmanage' | 'rsvg-convert';

const onPath = (command: string): string | undefined =>
  (process.env.PATH ?? '').split(delimiter).map((dir) => join(dir, command)).find((path) => existsSync(path));

/** How PNGs get made on this machine, if at all. */
export const pngRoute = (): PngRoute | undefined => {
  if (process.platform === 'darwin' && existsSync('/usr/bin/qlmanage')) {
    return 'qlmanage';
  }
  return onPath('rsvg-convert') ? 'rsvg-convert' : undefined;
};

const run = promisify(execFile);

/** Rasterises an SVG of the given CSS size. Throws when no PNG route exists. */
export const svgToPng = async (svg: string, width: number, height: number, scale = 2): Promise<Buffer> => {
  const route = pngRoute();
  if (!route) {
    throw new Error('No SVG rasteriser: needs macOS (qlmanage) or rsvg-convert on PATH.');
  }
  const dir = mkdtempSync(join(tmpdir(), 'shelly-screen-'));
  try {
    const source = join(dir, 'screen.svg');
    writeFileSync(source, svg);
    const outWidth = Math.round(width * scale);
    const outHeight = Math.round(height * scale);
    if (route === 'rsvg-convert') {
      const target = join(dir, 'screen.png');
      await run('rsvg-convert', ['-z', String(scale), '-o', target, source]);
      return readFileSync(target);
    }
    // Quick Look draws the image scaled to fit a square of this size, top-left aligned, and pads the rest.
    const size = Math.max(outWidth, outHeight);
    await run('/usr/bin/qlmanage', ['-t', '-s', String(size), '-o', dir, source], { timeout: 30_000 });
    const thumbnail = decodePng(readFileSync(`${source}.png`));
    const fit = thumbnail.width / Math.max(width, height);
    return encodePng(cropImage(thumbnail, Math.round(width * fit), Math.round(height * fit)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

/** Size in CSS pixels of what `renderSvg` would draw. */
export const renderSize = (terminal: Terminal, options: RenderOptions = {}): { width: number; height: number } => {
  const { width, height } = metrics(readGrid(terminal, options), options);
  return { width, height };
};

export const renderPng = async (terminal: Terminal, options: PngOptions = {}): Promise<Buffer> => {
  const grid = readGrid(terminal, options);
  const { width, height } = metrics(grid, options);
  return svgToPng(gridToSvg(grid, options), width, height, options.scale);
};

export interface ScreenshotFiles {
  readonly txt: string;
  /** Missing when no PNG route exists; then `svg` and `html` are written instead. */
  readonly png?: string;
  readonly svg?: string;
  readonly html?: string;
  /** Why there is no PNG. */
  readonly pngError?: string;
}

export interface ScreenshotOptions extends PngOptions, TextOptions {
  /** Also write `.svg` and `.html` next to the PNG. */
  readonly extras?: boolean;
}

/**
 * Writes `<basePath>.txt` and `<basePath>.png` (or `.svg` and `.html` when
 * PNGs cannot be made here) and returns the paths.
 */
export const writeScreenshot = async (terminal: Terminal, basePath: string, options: ScreenshotOptions = {}): Promise<ScreenshotFiles> => {
  await flush(terminal);
  const grid = readGrid(terminal, options);
  const txt = `${basePath}.txt`;
  writeFileSync(txt, `${screenText(terminal, options)}\n`);
  const svgText = gridToSvg(grid, options);
  const files: { txt: string; png?: string; svg?: string; html?: string; pngError?: string } = { txt };
  try {
    const { width, height } = metrics(grid, options);
    const png = await svgToPng(svgText, width, height, options.scale);
    files.png = `${basePath}.png`;
    writeFileSync(files.png, png);
  } catch (error) {
    files.pngError = error instanceof Error ? error.message : String(error);
  }
  if (options.extras || !files.png) {
    files.svg = `${basePath}.svg`;
    writeFileSync(files.svg, svgText);
    files.html = `${basePath}.html`;
    writeFileSync(files.html, gridToHtml(grid, options));
  }
  return files;
};
