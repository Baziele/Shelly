/**
 * Where a streaming paragraph can be cut between rows, so its finished
 * rows go to scrollback while the rest still streams: the live region then
 * holds only the paragraph's last row, and a resize can disturb no more.
 *
 * Given the paragraph's markdown source and the rows it rendered to, this
 * finds the source offset where the row after the given ones starts, by
 * walking the rendered text and the source side by side: rendered
 * characters match the source, markup the renderer hides (`*`, `_`, `~`,
 * and backticks unless shown) is skipped, a rendered space matches a run of
 * source whitespace, and a row break eats the whitespace the wrap took.
 * Anything else (a link, an entity, an escape it cannot follow) and it
 * gives up: the paragraph then stays live until it is finished, as before.
 *
 * A cut is only offered where the markup before it is balanced (an even
 * number of delimiter runs of each marker), so the rows above it rendered on their own as
 * they did in the whole paragraph, and the rest renders as the paragraph's
 * next rows.
 */

/** Markers a renderer drops from the text it shows. */
const markersFor = (codeMarks: boolean): string => (codeMarks ? '*_~' : '*_~`');

const isSpace = (char: string | undefined): boolean => char !== undefined && /\s/.test(char);

/**
 * The cut after the most rows of `rows` (rendered rows of the paragraph,
 * trailing blanks trimmed) at which the source is balanced: how many rows,
 * and the UTF-16 offset into `source` where the next row's text starts.
 * Undefined when no row can be cut off with certainty.
 */
export const splitAfterRows = (
  source: string,
  rows: readonly string[],
  { codeMarks = false }: { readonly codeMarks?: boolean } = {},
): { readonly rows: number; readonly offset: number } | undefined => {
  const markers = markersFor(codeMarks);
  const isMarker = (char: string | undefined): boolean => char !== undefined && markers.includes(char);
  let at = 0;
  const skipMarkers = (): void => {
    while (isMarker(source[at])) {
      at++;
    }
  };
  // Balanced up to `end`: an even number of delimiter runs (`**` is one) of each marker, backticks
  // included whether shown or not. Conservative: a lone literal `*` also counts as open.
  const balanced = (end: number): boolean => {
    const runs = new Map<string, number>();
    for (const [run] of source.slice(0, end).matchAll(/\*+|_+|~+|`+/g)) {
      runs.set(run[0]!, (runs.get(run[0]!) ?? 0) + 1);
    }
    return [...runs.values()].every((count) => count % 2 === 0);
  };

  let best: { rows: number; offset: number } | undefined;
  for (const [index, row] of rows.entries()) {
    for (const char of Array.from(row.trimEnd())) {
      if (char === ' ') {
        // A space as rendered: whitespace in the source, maybe after closing markers.
        skipMarkers();
        if (!isSpace(source[at])) {
          return best;
        }
        while (isSpace(source[at])) {
          at++;
        }
        continue;
      }
      if (source.startsWith(char, at)) {
        at += char.length;
        continue;
      }
      skipMarkers();
      if (source[at] === '\\' && source.startsWith(char, at + 1)) {
        at += 1 + char.length;
        continue;
      }
      if (source.startsWith(char, at)) {
        at += char.length;
        continue;
      }
      return best;
    }
    // The end of a wrapped row: closing markers, then the whitespace the wrap took (none when a long
    // word was broken). Markers not followed by whitespace open the next row's text: left to it.
    const rowEnd = at;
    skipMarkers();
    if (isSpace(source[at])) {
      while (isSpace(source[at])) {
        at++;
      }
    } else {
      at = rowEnd;
    }
    if (at > 0 && at < source.length && balanced(at)) {
      best = { rows: index + 1, offset: at };
    }
  }
  return best;
};
