import { readdirSync } from 'node:fs';
import { delimiter } from 'node:path';

/*
 * Turning a fast-mode reply into what the client places on the input line.
 * The prompt asks for a bare command, or `# ` and a short answer; this
 * cleans up the ways a model still dresses a command up, and refuses to
 * put prose on the line: a reply that certainly reads as sentences is shown
 * as an answer instead, since running it could run what is in its
 * backticks. When in doubt it stays a command: losing a real command to an
 * "answer" costs the user a retype.
 */

export interface FastReply {
  readonly kind: 'command' | 'answer';
  /** A command, ready for the line; or an answer to show (plain text with inline markdown, never put on the line). */
  readonly text: string;
}

export interface ClassifyOptions {
  /** Whether a word is a command the user's shell can run (on PATH, or a builtin). */
  readonly isCommand?: (word: string) => boolean;
}

const FENCE = /```[^\n`]*\n([\s\S]*?)\n?```/;

const isComment = (line: string): boolean => line.trimStart().startsWith('#');

// ─── Reading lines as the shell does ────────────────────────────────────────

type Quote = 'none' | 'single' | 'double' | 'ansi' | 'backtick';

interface ScannedLine {
  readonly raw: string;
  /** Inside a string or a heredoc's body: not a command line. */
  readonly content: boolean;
  /** For a command line: the text outside quotes (backticked spans kept as they are). */
  readonly bare: string;
  /** For a command line: it ends inside a quote it opened, so how it reads is unknown. */
  readonly unbalanced: boolean;
}

/**
 * Scan a reply once, line by line, as the shell would: which lines are
 * commands and which are a multi-line string's or a heredoc's content, and
 * what each command line says outside its quotes. Handles '…', "…" (with
 * backslash escapes), $'…', `…` (opaque), # comments and <<heredocs.
 * `apostrophes` reads a ' between letters as an apostrophe (don't), as
 * prose has them; the shell would open a quote there.
 */
const scan = (text: string, apostrophes: boolean): ScannedLine[] => {
  const lines: ScannedLine[] = [];
  let quote: Quote = 'none';
  let terminator: string | null = null;
  for (const raw of text.split('\n')) {
    if (terminator !== null) {
      lines.push({ raw, content: true, bare: '', unbalanced: false });
      if (raw.trim() === terminator) terminator = null;
      continue;
    }
    const content = quote !== 'none';
    let bare = '';
    for (let index = 0; index < raw.length; index++) {
      const char = raw[index]!;
      switch (quote) {
        case 'single':
          if (char === "'") quote = 'none';
          continue;
        case 'ansi':
          if (char === '\\') index++;
          else if (char === "'") quote = 'none';
          continue;
        case 'double':
          if (char === '\\') index++;
          else if (char === '"') quote = 'none';
          continue;
        case 'backtick':
          bare += char;
          if (char === '\\') {
            bare += raw[index + 1] ?? '';
            index++;
          } else if (char === '`') quote = 'none';
          continue;
        case 'none':
          break;
      }
      if (char === '\\') {
        bare += raw.slice(index, index + 2);
        index++;
      } else if (char === '#' && (index === 0 || /\s/.test(raw[index - 1]!))) {
        break; // A comment to the end of the line.
      } else if (char === '$' && raw[index + 1] === "'") {
        quote = 'ansi';
        index++;
        bare += ' ';
      } else if (char === "'") {
        if (apostrophes && /[A-Za-z]/.test(raw[index - 1] ?? '') && /[a-z]/.test(raw[index + 1] ?? '')) bare += char;
        else {
          quote = 'single';
          bare += ' ';
        }
      } else if (char === '"') {
        quote = 'double';
        bare += ' ';
      } else if (char === '`') {
        quote = 'backtick';
        bare += char;
      } else {
        bare += char;
      }
    }
    const unbalanced = quote !== 'none' && !content;
    // A backticked span never runs on past its line in a reply worth reading.
    if (quote === 'backtick') quote = 'none';
    lines.push({ raw, content, bare, unbalanced });
    if (!content && quote === 'none') {
      // `<<EOF`, `<<-'EOF'`; not a `<<<` here-string.
      const heredoc = /(?<!<)<<(?!<)-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(raw);
      if (heredoc) terminator = heredoc[2]!;
    }
  }
  return lines;
};

// ─── Prose ──────────────────────────────────────────────────────────────────

/** Words that start an English sentence and no command. */
const SENTENCE_STARTERS = new Set([
  'A', 'Add', 'Also', 'Alternatively', 'An', 'And', 'Assuming', 'Because', 'Both', 'But', 'By', 'Check', 'Depending',
  'Each', 'Either', 'Enter', 'First', 'For', 'Here', 'How', 'I', 'If', 'In', 'Instead', 'It', 'Its', 'Just', 'Make',
  'No', 'Note', 'Now', 'On', 'Once', 'Or', 'Otherwise', 'Please', 'Run', 'Since', 'Simply', 'So', 'Sorry', 'Sure',
  'That', 'The', 'Then', 'There', 'These', 'This', 'Those', 'To', 'Try', 'Type', 'Unfortunately', 'Use', 'Using',
  'We', 'What', 'When', 'Which', 'While', 'Why', 'With', 'Without', 'Yes', 'You', 'Your',
]);

/** Builtins and keywords of bash, zsh and fish: commands though not on PATH. */
const SHELL_BUILTINS = new Set([
  '.', ':', '[', '[[', 'alias', 'autoload', 'bg', 'bind', 'bindkey', 'break', 'builtin', 'case', 'cd', 'command',
  'compgen', 'complete', 'continue', 'coproc', 'declare', 'dirs', 'disown', 'do', 'done', 'echo', 'elif', 'else',
  'emulate', 'enable', 'esac', 'eval', 'exec', 'exit', 'export', 'false', 'fc', 'fg', 'fi', 'for', 'function',
  'functions', 'getopts', 'hash', 'help', 'history', 'if', 'jobs', 'kill', 'let', 'local', 'logout', 'noglob', 'popd',
  'print', 'printf', 'pushd', 'pwd', 'read', 'readonly', 'rehash', 'return', 'select', 'set', 'setopt', 'shift',
  'shopt', 'source', 'suspend', 'test', 'then', 'time', 'times', 'trap', 'true', 'type', 'typeset', 'ulimit', 'umask',
  'unalias', 'unset', 'unsetopt', 'until', 'wait', 'whence', 'where', 'which', 'while', 'zle',
  // fish
  'abbr', 'and', 'argparse', 'begin', 'contains', 'count', 'end', 'math', 'not', 'or', 'set_color', 'status', 'string',
]);

let pathCache: { readonly path: string; readonly names: Set<string> } | null = null;

/** The names on PATH, exactly as spelled (macOS's file system would match `Use` to `use`). Read once per PATH. */
const namesOnPath = (path: string): Set<string> => {
  if (pathCache?.path === path) return pathCache.names;
  const names = new Set<string>();
  for (const dir of path.split(delimiter)) {
    if (dir === '') continue;
    try {
      for (const name of readdirSync(dir)) names.add(name);
    } catch {
      // A missing folder on PATH.
    }
  }
  pathCache = { path, names };
  return names;
};

const defaultIsCommand = (word: string): boolean => SHELL_BUILTINS.has(word) || namesOnPath(process.env.PATH ?? '').has(word);

/** A plain English word, maybe with an apostrophe and trailing punctuation: no flags, paths or operators. */
const PLAIN_WORD = /^[A-Za-z]+(?:['’][a-z]+)?[,.;:!?]?$/;
const LOWER_WORD = /^[a-z]+(?:['’][a-z]+)?[,.;:!?]?$/;
/** Operators and flags: a line with any of these is shell, whatever else it says. */
const SHELL_SYNTAX = /[|><;=&$(){}]|(?:^|\s)--?[A-Za-z0-9]/;

/** The first word runs: a command on PATH, a builtin, a path, an assignment or a group. */
const startsWithCommand = (first: string, isCommand: (word: string) => boolean): boolean =>
  first === '' || /[/=~]|^[.({!\\]/.test(first) || isCommand(first);

const proseLine = (line: ScannedLine, isCommand: (word: string) => boolean): boolean => {
  // Certain: a sentence start, "Use the …", "You can …", "Sure, ls". Read from the line as written,
  // before any quote, so a stray quote later on can't hide it.
  // The word after the starter may follow a flag or open a quote: "The -print0 flag …", "Use 'ls …".
  const [first = '', second = '', third = ''] = line.raw.trim().split(/\s+/);
  const starter = first.replace(/(?:['’][a-z]+)?[,:!]$/, '');
  const word = (token: string) => LOWER_WORD.test(token.replace(/^['"]/, ''));
  if (SENTENCE_STARTERS.has(starter) && !/['"`]/.test(first) && !isCommand(first) && (word(second) || word(third))) return true;

  // How the rest reads is unknown when a quote never closes: it stays a command.
  if (line.unbalanced) return false;
  const bare = line.bare.trim();
  if (bare === '') return false;
  const known = startsWithCommand(bare.split(/\s+/)[0]!, isCommand);

  // Certain: a backticked command inside words, "Run `git status` to see …", "`du -sh *` lists sizes".
  const spans = /`[^`]*`/g;
  if (/^[A-Z`]/.test(bare) && spans.test(bare)) {
    const outside = bare.replace(spans, ' ');
    const words = outside.split(/\s+/).filter((token) => PLAIN_WORD.test(token));
    if (words.length >= 2 && !SHELL_SYNTAX.test(outside)) return true;
  }

  // The rest only for a line that is no shell at all: no operators or flags, and no command first.
  if (known || SHELL_SYNTAX.test(bare)) return false;
  const tokens = bare.split(/\s+/);
  // Two sentences: a word ending one, a capitalised word starting the next.
  if (/[a-z]{2,}[.!?]\s+[A-Z][a-z]/.test(bare)) return true;
  // Dashes no command uses.
  if (/[—–]/.test(bare)) return true;
  // A sentence end on an all-words line: "Lists every file larger than 100MB."
  const plain = tokens.filter((token) => PLAIN_WORD.test(token)).length;
  return tokens.length >= 4 && /[A-Za-z]{2,}\.$/.test(bare) && plain / tokens.length >= 0.8;
};

/** A reply whose command lines read as English rather than as something to run. */
export const looksLikeProse = (text: string, options: ClassifyOptions = {}): boolean => {
  const isCommand = options.isCommand ?? defaultIsCommand;
  const shell = scan(text, false);
  // Command lines as the shell reads them; each read again allowing apostrophes, as prose has them.
  return shell.some((line) => !line.content && proseLine(scan(line.raw, true)[0]!, isCommand));
};

// ─── Shaping ────────────────────────────────────────────────────────────────

/** An answer: every non-empty line is a `# ` comment. */
const isAnswer = (text: string): boolean => {
  const lines = text.split('\n').filter((line) => line.trim() !== '');
  return lines.length > 0 && lines.every(isComment);
};

const unfence = (raw: string): string => {
  const fenced = FENCE.exec(raw);
  if (fenced) return fenced[1]!.trim();
  if (/^`[^`]+`$/.test(raw)) return raw.slice(1, -1).trim();
  return raw;
};

/** Every answer's shape: no fences, no `# ` markers, plain lines (inline `code` kept for the renderer). */
const answerText = (text: string): string =>
  text.replace(/^```[^\n]*\n?/gm, '').trim().split('\n').map((line) => line.trim().replace(/^#+ ?/, '').trimEnd()).join('\n').trim();

export const classifyReply = (raw: string, options: ClassifyOptions = {}): FastReply => {
  const trimmed = raw.trim();
  if (isAnswer(trimmed)) return { kind: 'answer', text: answerText(trimmed) };
  const text = unfence(trimmed);
  if (isAnswer(text)) return { kind: 'answer', text: answerText(text) };

  // Comment lines around a command (`# free port 3000`) are not part of what runs. Ones inside
  // it are: a heredoc's shebang or headings, a crontab line, a multi-line string.
  const scanned = scan(text, false);
  let start = 0;
  let end = scanned.length;
  while (start < end && (isComment(scanned[start]!.raw) || scanned[start]!.raw.trim() === '')) start++;
  // A trailing one stays when it is the content of a string still open above it.
  while (end > start && !scanned[end - 1]!.content && (isComment(scanned[end - 1]!.raw) || scanned[end - 1]!.raw.trim() === '')) end--;
  let lines = scanned.slice(start, end).map((line) => line.raw);
  // A prompt sign copied from a transcript: `$ ls`, on every line of a multi-line command.
  if (lines.some((line) => line.startsWith('$ ')) && lines.every((line) => line.startsWith('$ ') || line.trim() === '')) {
    lines = lines.map((line) => line.slice(2));
  }
  const command = lines.join('\n').trim();
  // Never put prose on the line: show it, shaped like any other answer.
  if (looksLikeProse(command, options)) return { kind: 'answer', text: answerText(trimmed) };
  return { kind: 'command', text: command };
};
