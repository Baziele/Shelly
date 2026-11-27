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

const unwrapCommand = (raw: string): string => {
  let text = raw;
  const fenced = FENCE.exec(text);
  if (fenced) text = fenced[1]!.trim();
  else if (/^`[^`]+`$/.test(text)) text = text.slice(1, -1).trim();

  // A prompt sign copied from a transcript: `$ ls`, on every line of a multi-line command.
  const lines = text.split('\n');
  if (lines.some((line) => line.startsWith('$ ')) && lines.every((line) => line.startsWith('$ ') || line.trim() === '')) {
    text = lines.map((line) => line.slice(2)).join('\n');
  }
  return text.trim();
};

export const classifyReply = (raw: string): FastReply => {
  let text = raw.trim();
  if (!text.startsWith('#')) text = unwrapCommand(text);

  if (text.startsWith('#')) {
    // Every line of an answer may carry its own `# `, which keeps it paste-safe.
    const lines = text.split('\n').map((line) => line.replace(/^#+ ?/, '').trimEnd());
    return { kind: 'answer', text: lines.join('\n').trim() };
  }
  return { kind: 'command', text };
};
