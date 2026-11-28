import type { OutputSnapshot } from './captured-output.js';

/*
 * Turns a command's raw output into the text it left on screen, as cheaply
 * as the output allows:
 *
 * 1. Plain text with colors: strip the escape sequences.
 * 2. Output that redraws within a line (progress bars, spinners, `\r` and
 *    erase-line updates): a small line renderer that knows the width.
 * 3. Output that moves the cursor between lines (multi-line progress,
 *    `docker pull`): replay through a terminal emulator, loaded on first use.
 */

// zsh's PROMPT_SP: after a command, it prints a marker (normally a reverse-video
// `%`), pads to the line's end and returns, so output without a trailing
// newline is not overwritten by the prompt. It belongs to the shell, not the
// command. A precmd() function may print a title after it.
const ZSH_PROMPT_SP = /(?:(?:\u001b\[[0-9;]*m)*[^\s\u001b](?:\u001b\[[0-9;]*m)*)? {8,}\r \r(?:\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\))*$/u;
/** The padding is one line wide, so the artifact is always near the end. */
const PROMPT_SP_WINDOW = 1024;

/** Moves the cursor to another line, scrolls, or erases the screen. */
const MOVES_BETWEEN_LINES = /\u001b\[[0-9;]*[ABEFHJSTdfrsu]|\u001b[78DEM]/u;
/** Moves the cursor within a line or erases part of it. */
const REDRAWS_LINE = /\r(?!\n)|\u0008|\u001b\[[0-9;]*[CDGK]/u;

const ESCAPE_SEQUENCES = new RegExp(
  [
    '\\u001b\\[[0-?]*[ -/]*[@-~]', // CSI
    '\\u001b\\][^\\u0007\\u001b]*(?:\\u0007|\\u001b\\\\)', // OSC
    '\\u001b[PX^_][^\\u001b]*\\u001b\\\\', // DCS, SOS, PM, APC
    '\\u001b[ -/]*[0-~]', // two-character and charset sequences
  ].join('|'),
  'gu',
);
// C0 controls other than tab and newline, DEL, and C1 controls.
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/gu;
const LINE_TOKENS = new RegExp(
  [
    '[^\\u0000-\\u001f\\u007f]+', // printable text
    '\\u001b\\[([0-9;?]*)[ -/]*([@-~])', // CSI, capturing parameters and final byte
    '\\u001b\\][^\\u0007\\u001b]*(?:\\u0007|\\u001b\\\\)',
    '\\u001b[PX^_][^\\u001b]*\\u001b\\\\',
    '\\u001b[ -/]*[0-~]',
    '[\\s\\S]', // a single control character
  ].join('|'),
  'gu',
);

export const renderOutput = async (snapshot: OutputSnapshot, columns: number): Promise<string> => {
  if (snapshot.omittedChars === 0) {
    return renderTerminalText(stripShellArtifacts(snapshot.head + snapshot.tail), columns);
  }

  const [head, tail] = await Promise.all([
    renderTerminalText(trimHeadAtCut(snapshot.head), columns),
    renderTerminalText(stripShellArtifacts(trimTailAtCut(snapshot.tail)), columns),
  ]);
  return `${head}\n[… ${snapshot.omittedChars.toLocaleString('en-US')} characters of output omitted …]\n${tail}`;
};

/** A partial line next to the cut is dropped when it is short; a long one is cut cleanly instead. */
const SEAM_LINE_CHARS = 1024;

const trimHeadAtCut = (head: string): string => {
  const newline = head.lastIndexOf('\n');
  if (newline !== -1 && head.length - newline <= SEAM_LINE_CHARS) {
    return head.slice(0, newline + 1);
  }
  // Mid-line: do not end inside an escape sequence or between surrogates.
  const escape = head.lastIndexOf('\u001b');
  let end = escape !== -1 && head.length - escape < 64 ? escape : head.length;
  if (end > 0 && /[\ud800-\udbff]/.test(head[end - 1] ?? '')) {
    end--;
  }
  return head.slice(0, end);
};

const trimTailAtCut = (tail: string): string => {
  const newline = tail.indexOf('\n');
  if (newline !== -1 && newline < SEAM_LINE_CHARS) {
    return tail.slice(newline + 1);
  }
  return /^[\udc00-\udfff]/.test(tail) ? tail.slice(1) : tail;
};

const stripShellArtifacts = (raw: string): string => {
  const cut = Math.max(0, raw.length - PROMPT_SP_WINDOW);
  const end = raw.slice(cut);
  const stripped = end.replace(ZSH_PROMPT_SP, '');
  return stripped === end ? raw : raw.slice(0, cut) + stripped;
};

export const renderTerminalText = async (raw: string, columns: number): Promise<string> => {
  const width = Math.max(columns, 20);
  const text = MOVES_BETWEEN_LINES.test(raw)
    ? await emulate(raw, width)
    : REDRAWS_LINE.test(raw)
      ? renderLines(raw, width)
      : stripEscapes(raw);
  return tidy(text);
};

const stripEscapes = (raw: string): string => raw
  .replace(ESCAPE_SEQUENCES, '')
  .replace(/\r\n/g, '\n')
  .replace(CONTROL_CHARACTERS, '');

/**
 * Replays output that only moves within the current line. Tracks the cursor
 * as an offset into the logical line, so `\r` returns to the start of the
 * row the cursor is on, as it does after a long line wraps.
 */
const renderLines = (raw: string, width: number): string => {
  const lines: string[] = [];
  let line: string[] = [];
  let cursor = 0;

  const rowStart = (): number => (cursor > 0 && cursor % width === 0 ? cursor - width : cursor - (cursor % width));
  const write = (character: string): void => {
    while (line.length < cursor) {
      line.push(' ');
    }
    line[cursor++] = character;
  };

  for (const [token, params = '', final] of raw.matchAll(LINE_TOKENS)) {
    if (final !== undefined) {
      const count = Number.parseInt(params, 10) || 0;
      const start = rowStart();
      switch (final) {
        case 'K': // erase in line: 0 to the end, 1 to the start, 2 all of it
          if (count === 0) {
            line.length = Math.min(line.length, cursor);
          } else if (count === 1) {
            line.fill(' ', start, Math.min(cursor + 1, line.length));
          } else {
            line.length = Math.min(line.length, start);
          }
          break;
        case 'C':
          cursor = Math.min(start + width - 1, cursor + Math.max(count, 1));
          break;
        case 'D':
          cursor = Math.max(start, cursor - Math.max(count, 1));
          break;
        case 'G':
          cursor = start + Math.min(width, Math.max(count, 1)) - 1;
          break;
      }
      continue;
    }

    switch (token) {
      case '\n':
        lines.push(line.join(''));
        line = [];
        cursor = 0;
        break;
      case '\r':
        cursor = rowStart();
        break;
      case '\b':
        cursor = Math.max(rowStart(), cursor - 1);
        break;
      case '\t': {
        const start = rowStart();
        cursor = start + Math.min(width - 1, (Math.floor((cursor - start) / 8) + 1) * 8);
        break;
      }
      default:
        if (token.charCodeAt(0) >= 0x20 && token[0] !== '\u001b' && token !== '\u007f') {
          for (const character of token) {
            write(character);
          }
        }
    }
  }

  lines.push(line.join(''));
  return lines.join('\n');
};

/** Trailing spaces off each line, blank lines off both ends. */
const tidy = (text: string): string => text
  .split('\n')
  .map((line) => line.trimEnd())
  .join('\n')
  .replace(/^\n+|\n+$/g, '');

type HeadlessModule = typeof import('@xterm/headless');
let terminalModule: Promise<HeadlessModule> | undefined;

const EMULATOR_ROWS = 24;
/**
 * Bounds the emulator's buffers, and so the memory a replay leaves behind
 * (5,000 lines left about 17 MB). Output this long rarely moves the cursor
 * between lines, and an agent is given the end of it, well within this.
 */
export const MAX_EMULATED_LINES = 1000;

const emulate = async (raw: string, width: number): Promise<string> => {
  // A CommonJS package: Node puts its exports on `default`, some loaders on the namespace.
  terminalModule ??= import('@xterm/headless').then((module: HeadlessModule | { default: HeadlessModule }) =>
    ('Terminal' in module ? module : module.default));
  const { Terminal } = await terminalModule;

  const lineCount = (raw.match(/\n/g)?.length ?? 0) + 1;
  const terminal = new Terminal({
    cols: width,
    rows: EMULATOR_ROWS,
    // Past this, the earliest lines scroll away.
    scrollback: Math.min(lineCount, MAX_EMULATED_LINES),
    allowProposedApi: true,
  });

  try {
    await new Promise<void>((resolve) => terminal.write(raw, resolve));
    const buffer = terminal.buffer.normal;
    const lines: string[] = [];
    for (let index = 0; index < buffer.length; index++) {
      const line = buffer.getLine(index);
      if (!line) {
        continue;
      }
      const text = line.translateToString();
      // Rejoin long lines the terminal wrapped, so text reads as it was written.
      if (line.isWrapped && lines.length > 0) {
        lines[lines.length - 1] += text;
      } else {
        lines.push(text);
      }
    }
    return lines.join('\n');
  } finally {
    terminal.dispose();
  }
};
