import { BoxRenderable, TextRenderable, type CliRenderer } from '@opentui/core';
import { displayWidth, padEnd, truncateEnd } from '../render/text-width.js';
import { fitLine, oneLine, seg, type Line, type Segment } from './agent/lines.js';
import { toStyledText } from './agent/styled.js';

export interface PickerItem {
  readonly id: string;
  /** The main text, matched by the filter. */
  readonly label: string;
  /** Muted columns after the label, aligned across rows: `claude`, `2h ago`, … */
  readonly columns?: readonly string[];
  /** More text the filter matches, never shown. */
  readonly keywords?: string;
  /** Marks the current choice (the active agent or mode). */
  readonly current?: boolean;
}

/**
 * Items whose label starts with `query` first, then those whose label or
 * keywords contain it, each group in its original order. Case-insensitive.
 */
export const filterItems = (items: readonly PickerItem[], query: string): PickerItem[] => {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return [...items];
  }
  const prefix: PickerItem[] = [];
  const contains: PickerItem[] = [];
  for (const item of items) {
    const label = item.label.toLowerCase();
    if (label.startsWith(needle)) {
      prefix.push(item);
    } else if (label.includes(needle) || item.keywords?.toLowerCase().includes(needle)) {
      contains.push(item);
    }
  }
  return [...prefix, ...contains];
};

const COLUMN_GAP = 2;
/** The label keeps at least this many cells (or its full width, if less) before columns are dropped. */
const MIN_LABEL_CELLS = 16;
/** The last column is cut to fit, but dropped below this many cells. */
const MIN_LAST_COLUMN_CELLS = 8;

/** One picker row per visible item: a selection marker, the label, then muted columns. */
export const formatPickerRows = (
  unsafeItems: readonly PickerItem[],
  selected: number,
  width: number,
  emptyText: string,
): Line[] => {
  // Labels come from threads, agents and modes: one line each, nothing the terminal would act on.
  const items = unsafeItems.map((item) => ({ ...item, label: oneLine(item.label), columns: item.columns?.map(oneLine) }));
  if (items.length === 0) {
    return [fitLine([seg(`  ${emptyText}`, 'muted')], width)];
  }
  const columnCount = Math.max(0, ...items.map((item) => item.columns?.length ?? 0));
  const columnWidths = Array.from({ length: columnCount }, (_, column) =>
    Math.max(0, ...items.map((item) => displayWidth(item.columns?.[column] ?? ''))));
  const labelWidth = Math.max(...items.map((item) => displayWidth(item.label)));
  const minLabel = Math.min(labelWidth, MIN_LABEL_CELLS);

  // Columns before the last keep their width; the last is cut to fit. Drop columns from the right until that works.
  const fixedWidth = (count: number): number => (count === 0
    ? 0
    : columnWidths.slice(0, count - 1).reduce((sum, columnWidth) => sum + COLUMN_GAP + columnWidth, 0) + COLUMN_GAP);
  let shown = columnCount;
  while (shown > 0 && width - 2 - minLabel - fixedWidth(shown) < Math.min(MIN_LAST_COLUMN_CELLS, columnWidths[shown - 1]!)) {
    shown--;
  }
  const lastColumnWidth = shown > 0 ? columnWidths[shown - 1]! : 0;
  const labelCells = Math.max(1, Math.min(labelWidth, width - 2 - fixedWidth(shown) - Math.min(lastColumnWidth, MIN_LAST_COLUMN_CELLS)));

  return items.map((item, index) => {
    const isSelected = index === selected;
    const marker: Segment = isSelected ? seg('› ', 'accent', { bold: true }) : seg('  ');
    const fitted = truncateEnd(item.label, labelCells);
    const label = shown > 0 ? padEnd(fitted, labelCells) : fitted;
    const row: Segment[] = [marker, isSelected ? seg(label, 'accent', { bold: true }) : seg(label, item.current ? 'success' : undefined)];
    for (let column = 0; column < shown; column++) {
      const text = item.columns?.[column] ?? '';
      const last = column === shown - 1;
      row.push(seg(' '.repeat(COLUMN_GAP)), seg(last ? text : padEnd(text, columnWidths[column]!), 'muted'));
    }
    return fitLine(row, width);
  });
};

export interface ListPickerOptions {
  readonly maxRows: number;
  /** Shown when no item matches. */
  readonly emptyText?: string;
}

/**
 * A filterable list drawn below the input: arrow keys move, the input's text
 * filters. Used for the slash-command popup and for pickers such as
 * /threads, /agent and /mode. The picker only draws and tracks the
 * selection; the view that owns it routes keys.
 */
export class ListPicker {
  readonly root: BoxRenderable;
  private readonly text: TextRenderable;
  private items: readonly PickerItem[] = [];
  private matches: PickerItem[] = [];
  private selectedIndex = 0;
  private query = '';
  /** First visible match, when there are more matches than rows. */
  private scrollTop = 0;
  private widthLimit = 80;
  /** Shown when nothing matches; the list hides without it. */
  private emptyText: string | undefined;

  constructor(renderer: CliRenderer, private readonly options: ListPickerOptions) {
    this.root = new BoxRenderable(renderer, { flexDirection: 'column', visible: false, flexShrink: 0 });
    this.text = new TextRenderable(renderer, { content: '', wrapMode: 'none' });
    this.root.add(this.text);
  }

  get visible(): boolean {
    return this.root.visible;
  }

  /** Rows the picker takes on screen (0 when hidden). */
  get height(): number {
    if (!this.root.visible) {
      return 0;
    }
    return this.matches.length === 0 ? (this.emptyText ? 1 : 0) : Math.min(this.matches.length, this.limit());
  }

  get selected(): PickerItem | undefined {
    return this.matches[this.selectedIndex];
  }

  get matchCount(): number {
    return this.matches.length;
  }

  /**
   * Show `items`, filtered by `query`, on a screen `width` cells wide. The
   * list starts at `preferredLeft` (0-based) when it fits there, else at the
   * left edge. The selection resets when the matches change.
   */
  show(items: readonly PickerItem[], query: string, width: number, preferredLeft = 0, emptyText?: string): void {
    const changed = items !== this.items || query !== this.query;
    this.emptyText = emptyText ?? this.options.emptyText;
    this.items = items;
    this.query = query;
    if (changed) {
      const matches = filterItems(items, query);
      const same = matches.length === this.matches.length && matches.every((item, index) => item.id === this.matches[index]?.id);
      this.matches = matches;
      if (!same) {
        const current = matches.findIndex((item) => item.current);
        this.selectedIndex = query === '' && current >= 0 ? current : 0;
        this.scrollTop = 0;
      }
    }
    this.root.visible = this.matches.length > 0 || Boolean(this.emptyText);
    const natural = Math.max(0, ...this.rows(Number.MAX_SAFE_INTEGER).map((row) => displayWidth(row.map((segment) => segment.text).join(''))));
    const left = preferredLeft + natural <= width ? preferredLeft : 0;
    this.root.marginLeft = left;
    this.widthLimit = Math.max(1, width - left);
    this.render();
  }

  hide(): void {
    this.root.visible = false;
  }

  move(step: number): void {
    const count = this.matches.length;
    if (count === 0) {
      return;
    }
    this.selectedIndex = (this.selectedIndex + step + count) % count;
    this.render();
  }

  /** Rows the list may take on this screen (at most `maxRows`); see setRowLimit. */
  private rowLimit: number | undefined;

  /** How many rows the screen leaves for the list. More matches than fit end in a `… N more` row. */
  setRowLimit(rows: number): void {
    this.rowLimit = Math.max(2, Math.min(this.options.maxRows, rows));
    this.render();
  }

  private limit(): number {
    return this.rowLimit ?? this.options.maxRows;
  }

  /** Items shown, leaving the last row for the `… N more` note when not all fit. */
  private itemRows(): number {
    return this.matches.length > this.limit() ? this.limit() - 1 : this.limit();
  }

  private visibleMatches(): PickerItem[] {
    const rows = this.itemRows();
    if (this.selectedIndex < this.scrollTop) {
      this.scrollTop = this.selectedIndex;
    } else if (this.selectedIndex >= this.scrollTop + rows) {
      this.scrollTop = this.selectedIndex - rows + 1;
    }
    return this.matches.slice(this.scrollTop, this.scrollTop + rows);
  }

  private rows(width: number): Line[] {
    const visible = this.visibleMatches();
    const rows = formatPickerRows(visible, this.selectedIndex - this.scrollTop, width, this.emptyText ?? '');
    const hidden = this.matches.length - visible.length;
    return hidden > 0 ? [...rows, [seg(`  … ${hidden} more`, 'muted')]] : rows;
  }

  private render(): void {
    if (!this.root.visible) {
      return;
    }
    const rows = this.rows(this.widthLimit);
    this.text.content = toStyledText(rows);
    this.text.height = rows.length;
  }
}
