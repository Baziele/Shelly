import { seg, type Line, type Segment } from './lines.js';

/*
 * A deliberately small highlighter for code blocks in agent answers:
 * comments, strings, numbers and common keywords, one line at a time. It
 * costs next to nothing and works for any language; tree-sitter would be
 * exact but only ships parsers for a few languages and needs a worker
 * (measured: ~0.75 s to the first highlight and ~55 MB more memory).
 */

const KEYWORDS = new Set([
  // Shared by most C-like languages, Python, Rust, Go, shell.
  'if', 'else', 'elif', 'fi', 'then', 'for', 'while', 'do', 'done', 'case', 'esac', 'in', 'return', 'break', 'continue',
  'function', 'fn', 'func', 'def', 'class', 'struct', 'enum', 'interface', 'type', 'impl', 'trait', 'module', 'package',
  'import', 'export', 'from', 'as', 'use', 'mod', 'pub', 'let', 'const', 'var', 'mut', 'static', 'new', 'this', 'self',
  'super', 'extends', 'implements', 'async', 'await', 'yield', 'try', 'catch', 'finally', 'throw', 'throws', 'raise',
  'except', 'with', 'match', 'switch', 'default', 'true', 'false', 'null', 'undefined', 'None', 'True', 'False', 'nil',
  'void', 'public', 'private', 'protected', 'readonly', 'echo', 'local', 'lambda', 'and', 'or', 'not', 'is', 'of',
  'typeof', 'instanceof', 'go', 'defer', 'select', 'chan', 'where', 'loop', 'unsafe', 'extern', 'crate', 'sudo',
]);

const HASH_COMMENT_LANGUAGES = new Set([
  'sh', 'bash', 'zsh', 'fish', 'shell', 'console', 'python', 'py', 'ruby', 'rb', 'yaml', 'yml', 'toml', 'perl', 'r',
  'make', 'makefile', 'dockerfile', 'conf', 'ini', 'nix', 'elixir', 'ex', 'powershell', 'ps1',
]);
const DASH_COMMENT_LANGUAGES = new Set(['sql', 'lua', 'haskell', 'hs']);

const TOKEN = /(\s+)|("(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?|`(?:[^`\\]|\\.)*`?)|(\b\d[\d_]*(?:\.\d+)?\b)|([A-Za-z_$][\w$]*)|(.)/g;

const commentStart = (line: string, language: string): number => {
  const markers: string[] = [];
  if (HASH_COMMENT_LANGUAGES.has(language)) {
    markers.push('#');
  } else if (DASH_COMMENT_LANGUAGES.has(language)) {
    markers.push('--');
  } else {
    markers.push('//');
    if (language === '' || language === 'text') {
      markers.push('#');
    }
  }
  // A marker inside a string does not start a comment; a rough check is enough here.
  let quote: string | undefined;
  for (let index = 0; index < line.length; index++) {
    const char = line[index]!;
    if (quote) {
      if (char === '\\') {
        index++;
      } else if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }
    for (const marker of markers) {
      // `#` mid-word (`a#b`, `${#x}`) is not a comment in shell.
      if (line.startsWith(marker, index) && (marker !== '#' || index === 0 || /\s/.test(line[index - 1]!))) {
        return index;
      }
    }
  }
  return -1;
};

const highlightDiffLine = (line: string): Line => {
  if (line.startsWith('+') && !line.startsWith('+++')) {
    return [seg(line, 'success')];
  }
  if (line.startsWith('-') && !line.startsWith('---')) {
    return [seg(line, 'error')];
  }
  if (line.startsWith('@@')) {
    return [seg(line, 'accent')];
  }
  return [seg(line, 'muted')];
};

/** One line of code as styled segments. `language` is the fence's info word, lowercased. */
export const highlightCodeLine = (line: string, language: string): Line => {
  if (language === 'diff' || language === 'patch') {
    return highlightDiffLine(line);
  }
  if (language === 'text' || language === 'txt' || language === 'plain' || language === 'output') {
    return [seg(line)];
  }

  const comment = commentStart(line, language);
  const code = comment >= 0 ? line.slice(0, comment) : line;
  const segments: Segment[] = [];
  for (const match of code.matchAll(TOKEN)) {
    const [text, space, string, number, word] = match;
    if (space !== undefined) {
      segments.push(seg(text));
    } else if (string !== undefined) {
      segments.push(seg(text, 'success'));
    } else if (number !== undefined) {
      segments.push(seg(text, 'warning'));
    } else if (word !== undefined && KEYWORDS.has(word)) {
      segments.push(seg(text, 'accent'));
    } else {
      segments.push(seg(text));
    }
  }
  if (comment >= 0) {
    segments.push(seg(line.slice(comment), 'muted', { italic: true }));
  }
  // Merge neighbours of the same style so the text buffer gets few chunks.
  return segments.reduce<Segment[]>((merged, segment) => {
    const last = merged.at(-1);
    if (last && last.tone === segment.tone && last.italic === segment.italic) {
      merged[merged.length - 1] = { ...last, text: last.text + segment.text };
    } else {
      merged.push(segment);
    }
    return merged;
  }, []);
};
