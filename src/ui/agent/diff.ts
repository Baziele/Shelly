/** A small line diff for showing an edit inline: counts and the first changed lines. */

export interface DiffLine {
  readonly kind: 'context' | 'add' | 'remove';
  readonly text: string;
}

/** Above this many cells in the comparison table, the middle is shown as replaced outright. */
const MAX_TABLE_CELLS = 2_000_000;

const splitLines = (text: string): string[] => {
  if (text === '') {
    return [];
  }
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  if (lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines;
};

/** Lines of `oldText` (null for a new file) changed into `newText`, in order. */
export const diffLines = (oldText: string | null, newText: string): DiffLine[] => {
  const before = splitLines(oldText ?? '');
  const after = splitLines(newText);

  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) {
    start++;
  }
  let endBefore = before.length;
  let endAfter = after.length;
  while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) {
    endBefore--;
    endAfter--;
  }

  const result: DiffLine[] = before.slice(0, start).map((text) => ({ kind: 'context', text }));
  const oldMiddle = before.slice(start, endBefore);
  const newMiddle = after.slice(start, endAfter);

  if (oldMiddle.length * newMiddle.length > MAX_TABLE_CELLS) {
    result.push(...oldMiddle.map((text): DiffLine => ({ kind: 'remove', text })));
    result.push(...newMiddle.map((text): DiffLine => ({ kind: 'add', text })));
  } else {
    result.push(...longestCommonSubsequenceDiff(oldMiddle, newMiddle));
  }

  result.push(...before.slice(endBefore).map((text): DiffLine => ({ kind: 'context', text })));
  return result;
};

const longestCommonSubsequenceDiff = (before: string[], after: string[]): DiffLine[] => {
  const rows = before.length;
  const cols = after.length;
  // lengths[i * (cols + 1) + j]: LCS length of before[i:] and after[j:].
  const lengths = new Uint32Array((rows + 1) * (cols + 1));
  for (let i = rows - 1; i >= 0; i--) {
    for (let j = cols - 1; j >= 0; j--) {
      lengths[i * (cols + 1) + j] = before[i] === after[j]
        ? lengths[(i + 1) * (cols + 1) + j + 1]! + 1
        : Math.max(lengths[(i + 1) * (cols + 1) + j]!, lengths[i * (cols + 1) + j + 1]!);
    }
  }

  const result: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < rows && j < cols) {
    if (before[i] === after[j]) {
      result.push({ kind: 'context', text: before[i]! });
      i++;
      j++;
    } else if (lengths[(i + 1) * (cols + 1) + j]! >= lengths[i * (cols + 1) + j + 1]!) {
      result.push({ kind: 'remove', text: before[i]! });
      i++;
    } else {
      result.push({ kind: 'add', text: after[j]! });
      j++;
    }
  }
  while (i < rows) {
    result.push({ kind: 'remove', text: before[i++]! });
  }
  while (j < cols) {
    result.push({ kind: 'add', text: after[j++]! });
  }
  return result;
};

export interface DiffStats {
  readonly added: number;
  readonly removed: number;
}

export const diffStats = (lines: readonly DiffLine[]): DiffStats => ({
  added: lines.filter((line) => line.kind === 'add').length,
  removed: lines.filter((line) => line.kind === 'remove').length,
});

export interface DiffExcerpt {
  readonly lines: readonly DiffLine[];
  /** Changed lines left out of the excerpt. */
  readonly moreChanges: number;
}

/**
 * The first changes, with `context` unchanged lines around each run of them,
 * at most `maxLines` lines in all.
 */
export const diffExcerpt = (lines: readonly DiffLine[], maxLines: number, context = 1): DiffExcerpt => {
  const keep = new Array<boolean>(lines.length).fill(false);
  lines.forEach((line, index) => {
    if (line.kind === 'context') {
      return;
    }
    for (let near = Math.max(0, index - context); near <= Math.min(lines.length - 1, index + context); near++) {
      keep[near] = true;
    }
  });

  const excerpt: DiffLine[] = [];
  let lastKept = -1;
  for (let index = 0; index < lines.length && excerpt.length < maxLines; index++) {
    if (!keep[index]) {
      continue;
    }
    // A gap between two runs of changes ends the excerpt: one hunk only.
    if (lastKept >= 0 && index !== lastKept + 1) {
      break;
    }
    excerpt.push(lines[index]!);
    lastKept = index;
  }
  // Context after the last change shown is only worth its row if a change follows.
  while (excerpt.length > 0 && excerpt[excerpt.length - 1]!.kind === 'context' && excerpt.length === maxLines) {
    excerpt.pop();
  }

  const shownChanges = excerpt.filter((line) => line.kind !== 'context').length;
  const totalChanges = lines.filter((line) => line.kind !== 'context').length;
  return { lines: excerpt, moreChanges: totalChanges - shownChanges };
};
