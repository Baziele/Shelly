import type { OutputSnapshot } from './captured-output.js';

/*
 * Turns a command's raw output into the text it left on screen.
 *
 * Most output is plain text with colors, so stripping escape sequences is
 * enough. Output that moves the cursor or redraws lines (progress bars,
 * spinners, `\r` updates) is replayed through a terminal emulator instead,
 * which is loaded only when first needed.
 */

// zsh's PROMPT_SP: after a command, it prints a marker (normally a reverse-video
// `%`), pads to the line's end and returns, so output without a trailing
// newline is not overwritten by the prompt. It belongs to the shell, not the command.
const ZSH_PROMPT_SP = /(?:(?:\u001b\[[0-9;]*m)*[^\s\u001b](?:\u001b\[[0-9;]*m)*)? {8,}\r \r$/u;

/** Anything a plain-text reading would get wrong: cursor moves, erases, overwrites. */
const NEEDS_EMULATION = /\r(?!\n)|\u0008|\u001b\[[0-9;?]*[A-HJKSTdfsu]|\u001b[78DEM]/u;

const ESCAPE_SEQUENCES = new RegExp(
  [
    '\\u001b\\[[0-?]*[ -/]*[@-~]', // CSI
    '\\u001b\\][^\\u0007\\u001b]*(?:\\u0007|\\u001b\\\\)', // OSC
    '\\u001b[PX^_][^\\u001b]*\\u001b\\\\', // DCS, SOS, PM, APC
    '\\u001b[ -/]*[0-~]', // two-character and charset sequences
  ].join('|'),
  'gu',
);
// C0 controls other than tab and newline, plus DEL.
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b-\u001f\u007f]/gu;

export const renderOutput = async (snapshot: OutputSnapshot, columns: number): Promise<string> => {
  if (!snapshot.tail) {
    return renderTerminalText(stripShellArtifacts(snapshot.head), columns);
  }

  const [head, tail] = await Promise.all([
    renderTerminalText(snapshot.head, columns),
    renderTerminalText(stripShellArtifacts(snapshot.tail), columns),
  ]);
  return `${head}\n[… ${snapshot.omittedChars.toLocaleString('en-US')} characters of output omitted …]\n${tail}`;
};

const stripShellArtifacts = (raw: string): string => raw.replace(ZSH_PROMPT_SP, '');

export const renderTerminalText = async (raw: string, columns: number): Promise<string> => {
  const text = NEEDS_EMULATION.test(raw) ? await emulate(raw, columns) : stripEscapes(raw);
  return tidy(text);
};

const stripEscapes = (raw: string): string => raw
  .replace(ESCAPE_SEQUENCES, '')
  .replace(/\r\n/g, '\n')
  .replace(CONTROL_CHARACTERS, '');

/** Trailing spaces off each line, blank lines off both ends. */
const tidy = (text: string): string => text
  .split('\n')
  .map((line) => line.trimEnd())
  .join('\n')
  .replace(/^\n+|\n+$/g, '');

type HeadlessModule = typeof import('@xterm/headless');
let terminalModule: Promise<HeadlessModule> | undefined;

const EMULATOR_ROWS = 24;

const emulate = async (raw: string, columns: number): Promise<string> => {
  // A CommonJS package: Node puts its exports on `default`, some loaders on the namespace.
  terminalModule ??= import('@xterm/headless').then((module: HeadlessModule | { default: HeadlessModule }) =>
    ('Terminal' in module ? module : module.default));
  const { Terminal } = await terminalModule;

  const lineCount = (raw.match(/\n/g)?.length ?? 0) + 1;
  const terminal = new Terminal({
    cols: Math.max(columns, 20),
    rows: EMULATOR_ROWS,
    scrollback: lineCount + EMULATOR_ROWS,
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
