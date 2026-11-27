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

  // A comment line beside a command (`# free port 3000`) is not part of what runs.
  let lines = text.split('\n').filter((line) => !isComment(line));
  // A prompt sign copied from a transcript: `$ ls`, on every line of a multi-line command.
  if (lines.some((line) => line.startsWith('$ ')) && lines.every((line) => line.startsWith('$ ') || line.trim() === '')) {
    lines = lines.map((line) => line.slice(2));
  }
  return { kind: 'command', text: lines.join('\n').trim() };
};
