import type { ThreadEvent, ThreadEventOf, ToolCall } from '../../protocol/schema.js';
import type { PaintRow } from '../../render/live-region.js';
import type { ColorDepth } from '../../render/sgr.js';
import { displayWidth, truncateEnd } from '../../render/text-width.js';
import { formatSummary, formatToolSummary, relativeTime, type FormatContext } from './format.js';
import { fitLine, oneLine, seg, type Line } from './lines.js';
import { lineToPaintRow } from './paint-line.js';
import { renderMarkdownRows, rowsToText } from './static-render.js';

export interface HistoryOptions {
  readonly agentName: string;
  /** The thread's title, for the header rule. */
  readonly title: string;
  /** When the thread was last active (epoch ms). */
  readonly updatedAt: number;
  readonly cwd: string;
  readonly home: string;
  readonly width: number;
  readonly colorDepth: ColorDepth;
  /** The answer is cut after this many rows. */
  readonly maxAnswerRows?: number;
  /** Tool calls beyond this many are counted, not listed. */
  readonly maxTools?: number;
  readonly now?: number;
}

interface Exchange {
  prompt: string;
  tools: ToolCall[];
  /** The last message of the turn: its answer. */
  answer: string;
  ended: ThreadEventOf<'turn.ended'> | undefined;
}

/** The last turn of a thread's events, reduced to what history shows. */
const lastExchange = (events: readonly ThreadEvent[]): Exchange | undefined => {
  let exchange: Exchange | undefined;
  let messageId: string | undefined;
  const tools = new Map<string, ToolCall>();
  for (const event of events) {
    switch (event.type) {
      case 'turn.started':
        exchange = { prompt: event.text, tools: [], answer: '', ended: undefined };
        messageId = undefined;
        tools.clear();
        break;
      case 'message.chunk':
        if (!exchange || event.kind !== 'text') {
          break;
        }
        // `replace`: the message's whole text so far, not more of it.
        exchange.answer = event.messageId === messageId && !event.replace ? exchange.answer + event.text : event.text;
        messageId = event.messageId;
        break;
      case 'tool.updated':
        if (exchange) {
          if (!tools.has(event.tool.id)) {
            exchange.tools.push(event.tool);
          } else {
            exchange.tools[exchange.tools.findIndex((tool) => tool.id === event.tool.id)] = event.tool;
          }
          tools.set(event.tool.id, event.tool);
        }
        break;
      case 'turn.ended':
        if (exchange) {
          exchange.ended = event;
        }
        break;
      default:
        break;
    }
  }
  return exchange;
};

/** `── “title” · claude · 2h ago ─────` across the width. */
const headerRule = (options: HistoryOptions, now: number): Line => {
  const meta = ` · ${options.agentName} · ${relativeTime(options.updatedAt, now)} `;
  const room = Math.max(4, options.width - displayWidth(meta) - 3 - 4);
  const title = `“${truncateEnd(oneLine(options.title), room)}”`;
  const used = 3 + displayWidth(title) + displayWidth(meta);
  return fitLine([
    seg('── ', 'muted'),
    seg(title, undefined, { bold: true }),
    seg(meta, 'muted'),
    seg('─'.repeat(Math.max(2, options.width - used)), 'muted'),
  ], options.width);
};

/**
 * A past exchange printed statically, for when the user switches to an old
 * thread: a header rule, the request, one row per tool call, and the answer
 * cut to about 20 rows. Returns text ready to write to the terminal, each
 * row ending in CRLF.
 */
export const renderHistory = async (events: readonly ThreadEvent[], options: HistoryOptions): Promise<string> => {
  const now = options.now ?? Date.now();
  const maxAnswerRows = options.maxAnswerRows ?? 20;
  const maxTools = options.maxTools ?? 6;
  const agentName = oneLine(options.agentName) || 'agent';
  const context: FormatContext = { cwd: options.cwd, home: options.home, width: options.width, agentName, spinner: '·' };
  const rows: PaintRow[] = [lineToPaintRow(headerRule({ ...options, agentName }, now))];
  const exchange = lastExchange(events);
  if (!exchange) {
    rows.push(lineToPaintRow([seg('Nothing here yet.', 'muted')]));
    return rowsToText(rows, options.colorDepth);
  }

  rows.push(lineToPaintRow(fitLine([seg(':: ', 'accent', { bold: true }), seg(oneLine(exchange.prompt))], options.width)));

  const shownTools = exchange.tools.length > maxTools ? exchange.tools.slice(0, maxTools - 1) : exchange.tools;
  for (const tool of shownTools) {
    rows.push(lineToPaintRow(formatToolSummary(tool, context)));
  }
  if (shownTools.length < exchange.tools.length) {
    rows.push(lineToPaintRow([seg(`  … ${exchange.tools.length - shownTools.length} more tool calls`, 'muted')]));
  }

  if (exchange.answer.trim()) {
    const answer = await renderMarkdownRows(exchange.answer, options.width);
    // Cutting a row short of the limit beats a lone row after the note.
    const cut = answer.length > maxAnswerRows + 1 ? maxAnswerRows : answer.length;
    if (shownTools.length > 0) {
      rows.push([]);
    }
    rows.push(...answer.slice(0, cut));
    if (cut < answer.length) {
      rows.push(lineToPaintRow([seg(`… (${answer.length - cut} more lines)`, 'muted')]));
    }
  }

  if (exchange.ended) {
    rows.push([]);
    rows.push(lineToPaintRow(formatSummary(exchange.ended, exchange.tools.length, context)));
  }
  return rowsToText(rows, options.colorDepth);
};
