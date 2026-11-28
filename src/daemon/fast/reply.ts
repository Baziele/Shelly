/*
 * Turning a fast-mode reply into what the client places on the input line.
 * The prompt asks for a bare command, or `# ` and a short answer; this
 * cleans up the ways a model still dresses a command up, and refuses to
 * put prose on the line: a reply that reads as sentences is shown as an
 * answer instead, since running it could run what is in its backticks.
 */

export interface FastReply {
  readonly kind: 'command' | 'answer';
  readonly text: string;
}

const FENCE = /```[^\n`]*\n([\s\S]*?)\n?```/;

const isComment = (line: string): boolean => line.trimStart().startsWith('#');

/** Whether `text` ends inside a quoted string, as the shell reads quotes. */
const endsInQuote = (text: string): boolean => {
  let quote: '"' | "'" | null = null;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quote === "'") {
      if (char === "'") quote = null;
    } else if (char === '\\') {
      index++;
    } else if (quote === '"') {
      if (char === '"') quote = null;
    } else if (char === '"' || char === "'") {
      quote = char;
    }
  }
  return quote !== null;
};

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

const answerText = (text: string): string =>
  // Every line of an answer may carry its own `# `, which keeps it paste-safe.
  text.trim().split('\n').map((line) => line.trim().replace(/^#+ ?/, '').trimEnd()).join('\n').trim();

// ─── Prose ──────────────────────────────────────────────────────────────────

/** Words that start an English sentence and no command (commands are lowercase; `R`, `Rscript`, `Xvfb` are not here). */
const SENTENCE_STARTERS = new Set([
  'A', 'Add', 'Also', 'Alternatively', 'An', 'And', 'Assuming', 'Because', 'Both', 'But', 'By', 'Check', 'Depending',
  'Each', 'Either', 'Enter', 'First', 'For', 'Here', 'How', 'I', 'If', 'In', 'Instead', 'It', 'Its', 'Just', 'Make',
  'No', 'Note', 'Now', 'On', 'Once', 'Or', 'Otherwise', 'Please', 'Run', 'Since', 'Simply', 'So', 'Sorry', 'Sure',
  'That', 'The', 'Then', 'There', 'These', 'This', 'Those', 'To', 'Try', 'Type', 'Unfortunately', 'Use', 'Using',
  'We', 'What', 'When', 'Which', 'While', 'Why', 'With', 'Without', 'Yes', 'You', 'Your',
]);

/** A plain English word, maybe with an apostrophe and trailing punctuation: no flags, paths or operators. */
const PLAIN_WORD = /^[A-Za-z]+(?:['’][a-z]+)?[,.;:!?]?$/;
const LOWER_WORD = /^[a-z]+(?:['’][a-z]+)?[,.;:!?]?$/;
const SHELL_OPERATOR = /[;|&<>$=()]/;

/** The parts of a line the shell reads as words: quoted strings removed (an apostrophe inside a word is not a quote). */
const unquoted = (line: string): string => {
  let out = '';
  let quote: '"' | "'" | null = null;
  for (let index = 0; index < line.length; index++) {
    const char = line[index]!;
    if (quote) {
      if (char === '\\' && quote === '"') index++;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '\\') {
      index++;
      continue;
    }
    const apostrophe = char === "'" && /[A-Za-z]/.test(line[index - 1] ?? '') && /[a-z]/.test(line[index + 1] ?? '');
    if ((char === '"' || char === "'") && !apostrophe) {
      quote = char;
      out += ' ';
      continue;
    }
    out += char;
  }
  return out;
};

/** The lines the shell reads as commands: not a heredoc's body, not the inside of a multi-line string. */
const commandLines = (text: string): string[] => {
  const lines: string[] = [];
  let terminator: string | null = null;
  let before = '';
  for (const line of text.split('\n')) {
    const inString = endsInQuote(before);
    before += `${line}\n`;
    if (terminator !== null) {
      if (line.trim() === terminator) terminator = null;
      continue;
    }
    if (inString) continue;
    lines.push(line);
    // `<<EOF`, `<<-'EOF'`; not a `<<<` here-string.
    const heredoc = /(?<!<)<<(?!<)-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(line);
    if (heredoc) terminator = heredoc[2]!;
  }
  return lines;
};

const proseLine = (line: string): boolean => {
  const bare = unquoted(line).trim();
  if (bare === '') return false;
  // Dashes no command uses.
  if (/[—–]/.test(bare)) return true;
  // Two sentences: a word ending one, a capitalised word starting the next.
  if (/[a-z]{2,}[.!?]\s+[A-Z][a-z]/.test(bare)) return true;

  const spans = /`[^`]*`/g;
  const hasSpans = spans.test(bare);
  const outside = bare.replace(spans, ' ');
  const tokens = bare.split(/\s+/);
  const [first = '', second = ''] = tokens;
  const firstWord = first.replace(/(?:['’][a-z]+)?[,:!]$/, '');

  // A sentence start: "Use the …", "Run `ls` …", "You can …", "Sure, …".
  if (SENTENCE_STARTERS.has(firstWord) && (LOWER_WORD.test(second) || second.startsWith('`') || /[,:!]$/.test(first))) return true;
  // A capitalised verb or noun and then words: "Lists every file …".
  if (/^[A-Z][a-z]+$/.test(first) && tokens.slice(1, 3).length === 2 && tokens.slice(1, 3).every((token) => LOWER_WORD.test(token))) return true;

  // Ends a sentence, and is all words: "git fetch downloads; git pull also merges."
  const plain = tokens.filter((token) => PLAIN_WORD.test(token)).length;
  if (tokens.length >= 4 && /[A-Za-z]{2,}\.$/.test(bare) && plain / tokens.length >= 0.8) return true;

  // A backticked command inside words: "`du -sh *` lists sizes".
  if (hasSpans && (bare.startsWith('`') || /^[A-Z]/.test(bare)) && !SHELL_OPERATOR.test(outside)) {
    const words = outside.split(/\s+/).filter((token) => LOWER_WORD.test(token));
    if (words.length >= 2) return true;
  }
  return false;
};

/** A reply that reads as English rather than as something to run. */
export const looksLikeProse = (text: string): boolean => commandLines(text).some(proseLine);

export const classifyReply = (raw: string): FastReply => {
  const trimmed = raw.trim();
  if (isAnswer(trimmed)) return { kind: 'answer', text: answerText(trimmed) };
  const text = unfence(trimmed);
  if (isAnswer(text)) return { kind: 'answer', text: answerText(text) };

  // Comment lines around a command (`# free port 3000`) are not part of what runs. Ones inside
  // it are: a heredoc's shebang or headings, a crontab line, a multi-line string.
  let lines = text.split('\n');
  while (lines.length > 0 && (isComment(lines[0]!) || lines[0]!.trim() === '')) lines.shift();
  while (lines.length > 0 && (isComment(lines.at(-1)!) || lines.at(-1)!.trim() === '')) {
    // Not when it is the end of a string still open above it.
    if (lines.at(-1)!.trim() !== '' && endsInQuote(lines.slice(0, -1).join('\n'))) break;
    lines.pop();
  }
  // A prompt sign copied from a transcript: `$ ls`, on every line of a multi-line command.
  if (lines.some((line) => line.startsWith('$ ')) && lines.every((line) => line.startsWith('$ ') || line.trim() === '')) {
    lines = lines.map((line) => line.slice(2));
  }
  const command = lines.join('\n').trim();
  // Never put prose on the line: show it.
  if (looksLikeProse(command)) return { kind: 'answer', text: trimmed };
  return { kind: 'command', text: command };
};
