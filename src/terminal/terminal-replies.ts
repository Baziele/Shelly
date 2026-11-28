/*
 * The terminal's answers to the shell's queries, told apart from keys.
 * While Shelly holds the user's keys, an answer the shell is waiting for
 * (fish 4 waits for some while its line is set) must still reach it at
 * once: held, then stripped as not text, it would never arrive. But some
 * answers look exactly like keys: a cursor report `ESC[1;5R` is also
 * Ctrl+F3. So a sequence counts as an answer only while a query it
 * answers is outstanding: one the shell's output put on the terminal and
 * no answer has come for yet. Anything else is a key, and waits with the
 * other keys.
 */

/** What a query asks for, and so what shape its answer has. */
type Kind = 'cursor' | 'status' | 'attributes' | 'mode' | 'keyboard' | 'window' | 'osc' | 'dcs';

/** A terminal that does not know a query never answers it: after this, the query no longer counts. */
const ANSWER_WAIT_MS = 2000;
/**
 * Most queries waiting at once. A shell asks a handful at a time; output
 * full of them (a file of escape sequences on the screen) with nobody
 * typing would otherwise pile up. The oldest go first.
 */
const MAX_OUTSTANDING = 32;
/** Longest piece of an unfinished query kept for the next chunk of output. */
const MAX_TAIL = 256;

/**
 * The queries, and only them (this runs on all the shell's output, so it
 * must fail fast on everything else): cursor position and status (DSR),
 * device attributes (DA1-3), modes (DECRQM), kitty keyboard flags, XTVERSION,
 * window reports, colours and the clipboard (OSC `?`), DECRQSS and XTGETTCAP.
 */
const QUERY = /\u001b\[(?:(\??\d+)n|([>=]?)0?c|\??\d+\$p|\?u|>0?q|(\d+)(?:;\d+)*t)|\u001b\][\d;]*;\?(?:\u0007|\u001b\\)|\u001bP[$+]q[^\u001b]*\u001b\\/g;
/** An escape sequence that a piece of output ends in the middle of. */
const UNFINISHED = /^\u001b(?:\[[0-9;:?<>=!$]*|\][\d;?]*|P[^\u001b]*)?$/;

/** The answer a query waits for. */
const queryKind = (match: RegExpMatchArray): Kind | undefined => {
  const [query, status, attributes, window] = match;
  if (status !== undefined) {
    return status === '6' || status === '?6' ? 'cursor' : 'status';
  }
  if (attributes !== undefined) {
    return attributes === '=' ? 'dcs' : 'attributes';
  }
  if (window !== undefined) {
    const op = Number(window);
    return [11, 13, 14, 15, 16, 18, 19].includes(op) ? 'window' : op === 20 || op === 21 ? 'osc' : undefined;
  }
  return query.startsWith('\u001b]') ? 'osc'
    : query.startsWith('\u001bP') || query.endsWith('q') ? 'dcs'
    : query.endsWith('p') ? 'mode'
    : 'keyboard';
};

const ANSWER = /\u001b\[\??\d+(?:;\d+)*R|\u001b\[[?>=][\d;]*c|\u001b\[\??[\d;]*\$y|\u001b\[\?\d*u|\u001b\[\??\d+(?:;\d+)*n|\u001b\[\d+(?:;\d+)*t|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001bP[^\u001b]*\u001b\\/g;

/** The kind of query a sequence from the terminal would answer. */
const answerKind = (answer: string): Kind => {
  if (answer.startsWith('\u001b]')) {
    return 'osc';
  }
  if (answer.startsWith('\u001bP')) {
    return 'dcs';
  }
  const final = answer.at(-1);
  return final === 'R' ? 'cursor'
    : final === 'c' ? 'attributes'
    : final === 'y' ? 'mode'
    : final === 'u' ? 'keyboard'
    : final === 'n' ? 'status'
    : 'window';
};

export class TerminalReplies {
  private outstanding: { readonly kind: Kind; readonly at: number }[] = [];
  private tail = '';

  constructor(private readonly now: () => number = Date.now) {}

  /** Shell output on its way to the terminal: note the queries in it. */
  asked(output: string): void {
    // On all the shell's output: most of it has no escape at all.
    if (!this.tail && output.indexOf('\u001b') < 0) {
      return;
    }
    const data = this.tail + output;
    const at = this.now();
    let added = false;
    for (const match of data.matchAll(QUERY)) {
      const kind = queryKind(match);
      if (kind) {
        this.outstanding.push({ kind, at });
        added = true;
      }
    }
    if (added) {
      this.expire();
      if (this.outstanding.length > MAX_OUTSTANDING) {
        this.outstanding.splice(0, this.outstanding.length - MAX_OUTSTANDING);
      }
    }
    const last = data.lastIndexOf('\u001b');
    const unfinished = last >= 0 && data.length - last <= MAX_TAIL ? data.slice(last) : '';
    this.tail = UNFINISHED.test(unfinished) ? unfinished : '';
  }

  /** Some query is still waiting for its answer. */
  get waiting(): boolean {
    this.expire();
    return this.outstanding.length > 0;
  }

  /**
   * Take out of `data` the answers to outstanding queries (each answer
   * settles one); what is left are keys, and look-alikes of answers no
   * query is waiting for stay among them.
   */
  split(data: string): { readonly replies: string; readonly keys: string } {
    if (!data.includes('\u001b') || !this.waiting) {
      return { replies: '', keys: data };
    }
    let replies = '';
    const keys = data.replace(ANSWER, (answer) => {
      const kind = answerKind(answer);
      const index = this.outstanding.findIndex((query) => query.kind === kind);
      if (index < 0) {
        return answer;
      }
      this.outstanding.splice(index, 1);
      replies += answer;
      return '';
    });
    return { replies, keys };
  }

  private expire(): void {
    const now = this.now();
    if (this.outstanding.length > 0 && now - this.outstanding[0]!.at > ANSWER_WAIT_MS) {
      this.outstanding = this.outstanding.filter((query) => now - query.at <= ANSWER_WAIT_MS);
    }
  }
}
