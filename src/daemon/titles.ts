/*
 * A thread's title. For now it is the first prompt, cut at a word boundary;
 * this is the hook where a generated title (a fast-mode request, say) can
 * replace it once the first turn ends.
 */

export const TITLE_MAX_CHARS = 60;

export const initialTitle = (text: string, maxChars = TITLE_MAX_CHARS): string => {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= maxChars) {
    return flat;
  }
  const cut = flat.slice(0, maxChars - 1);
  const space = cut.lastIndexOf(' ');
  // Keep a word whole unless that would leave almost nothing.
  const head = space >= maxChars / 2 ? cut.slice(0, space) : cut;
  return `${head.replace(/[\s.,;:!?-]+$/, '')}…`;
};
