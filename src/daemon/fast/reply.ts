/*
 * Turning a fast-mode reply into what the client places on the input line.
 * The prompt asks for a bare command, or `# ` and a short answer; this
 * cleans up the ways a model still dresses a command up.
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
  return { kind: 'command', text: lines.join('\n').trim() };
};
