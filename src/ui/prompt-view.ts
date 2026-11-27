import {
  BoxRenderable,
  InputRenderable,
  InputRenderableEvents,
  TextRenderable,
  bold,
  fg,
  t,
  type CliRenderer,
  type KeyEvent,
} from '@opentui/core';
import { parseSlashQuery, type CommandRegistry } from '../commands/slash-commands.js';
import { displayWidth, truncateEnd, truncateStart } from '../render/text-width.js';
import { SPINNER_INTERVAL_MS, spinnerFrame } from './agent/format.js';
import { oneLine, seg } from './agent/lines.js';
import { toStyledText } from './agent/styled.js';
import { ListPicker, type PickerItem } from './list-picker.js';
import { theme } from './theme.js';

export const MAX_POPUP_ROWS = 6;
/** Tallest the view can get: the input row, a rewriting row, a message row and a full popup. */
export const MAX_VIEW_ROWS = 3 + MAX_POPUP_ROWS;

/** The trigger that opens fast mode; anything else is agent mode. */
export const FAST_TRIGGER = '__';

/** Below this many cells between the typed text and the edge, the hint is hidden. */
const HINT_GAP = 3;
/** The streamed preview moves to its own row when less room than this is left beside the text. */
const MIN_PREVIEW_CELLS = 16;

export type PromptMode = 'agent' | 'fast';

export interface PromptViewHandlers {
  readonly onSubmit: (text: string) => void;
  readonly onCancel: () => void;
}

export interface PromptViewPlacement {
  /** 1-based column where the input row begins; everything left of it belongs to the shell. */
  readonly inputCol: number;
  /** The trigger the user typed, shown as the input's marker. */
  readonly trigger: string;
  /** Defaults from the trigger: `__` is fast mode. */
  readonly mode?: PromptMode;
  /** Fast mode, opened from a half-typed command: the command being rewritten. */
  readonly rewriting?: string;
  /** Right-aligned, muted: where `::` will go (`claude · new thread`). */
  readonly hint?: string;
}

export interface PickerRequest {
  readonly items: readonly PickerItem[];
  /** Shown in the empty input: `Pick a thread · type to filter`. */
  readonly placeholder: string;
  /** Shown when nothing matches the filter. */
  readonly emptyText?: string;
  readonly onPick: (item: PickerItem) => void;
  /** Escape closes the picker and returns to the input. */
  readonly onClose: () => void;
}

/** Each placeholder, then a shorter one for when the row is narrow or the hint needs the room. */
const PLACEHOLDERS = {
  agent: ['Ask Shelly anything · / for commands', 'Ask anything'],
  fast: ['Describe a command · enter to insert', 'Describe a command'],
  rewrite: ['How should it change?', 'How should it change?'],
} as const satisfies Record<string, readonly [string, string]>;

/**
 * Shelly's input line and the list under it (slash commands or a picker),
 * built from OpenTUI components. The view lays itself out across the full
 * terminal width; the input row is indented to start where the shell prompt
 * ends.
 *
 * In fast mode the row also shows the request's progress: a spinner and the
 * reply as it streams, then an error if there was one.
 */
export class PromptView {
  private readonly root: BoxRenderable;
  private readonly inputRow: BoxRenderable;
  private readonly marker: TextRenderable;
  private readonly input: InputRenderable;
  private readonly progress: TextRenderable;
  private readonly hintText: TextRenderable;
  private readonly rewritingRow: TextRenderable;
  private readonly messageRow: TextRenderable;
  private readonly list: ListPicker;
  private active = false;
  private mode: PromptMode = 'agent';
  /** 0-based column where typed text starts, used to line the list up under it. */
  private textOffset = 0;
  private hint: string | undefined;
  private placeholders: readonly [string, string] = PLACEHOLDERS.agent;
  /** Escape hides the slash popup until the query changes. */
  private dismissedQuery: string | undefined;
  private picker: PickerRequest | undefined;
  private busy = false;
  private preview = '';
  private error: string | undefined;
  private spinnerTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly renderer: CliRenderer,
    private readonly commands: CommandRegistry,
    private readonly handlers: PromptViewHandlers,
  ) {
    this.root = new BoxRenderable(renderer, { flexDirection: 'column', width: '100%', visible: false });
    this.inputRow = new BoxRenderable(renderer, { flexDirection: 'row', width: '100%', height: 1 });
    this.marker = new TextRenderable(renderer, { content: '', flexShrink: 0 });
    this.input = new InputRenderable(renderer, {
      flexGrow: 1,
      flexShrink: 1,
      placeholder: PLACEHOLDERS.agent[0],
      placeholderColor: theme.muted,
      textColor: theme.text,
      focusedTextColor: theme.text,
      backgroundColor: theme.transparent,
      focusedBackgroundColor: theme.transparent,
    });
    this.progress = new TextRenderable(renderer, { content: '', visible: false, flexGrow: 1, flexShrink: 1, wrapMode: 'none' });
    this.hintText = new TextRenderable(renderer, { content: '', visible: false, flexShrink: 0, wrapMode: 'none' });
    this.rewritingRow = new TextRenderable(renderer, { content: '', visible: false, height: 1, wrapMode: 'none' });
    this.messageRow = new TextRenderable(renderer, { content: '', visible: false, height: 1, wrapMode: 'none' });
    this.list = new ListPicker(renderer, { maxRows: MAX_POPUP_ROWS });

    this.inputRow.add(this.marker);
    this.inputRow.add(this.input);
    this.inputRow.add(this.progress);
    this.inputRow.add(this.hintText);
    this.root.add(this.inputRow);
    this.root.add(this.rewritingRow);
    this.root.add(this.messageRow);
    this.root.add(this.list.root);
    renderer.root.add(this.root);

    this.input.on(InputRenderableEvents.INPUT, () => this.handleInputChange());
    this.input.on(InputRenderableEvents.ENTER, (value: string) => this.submit(value));
    // Runs before the focused input sees the key, so the list can claim it.
    renderer.keyInput.prependListener('keypress', (key) => this.handleKey(key));
  }

  /** Rows the view currently occupies on screen. */
  get height(): number {
    return 1 + (this.rewritingRow.visible ? 1 : 0) + (this.messageRow.visible ? 1 : 0) + this.list.height;
  }

  get value(): string {
    return this.input.value;
  }

  get currentMode(): PromptMode {
    return this.mode;
  }

  open(placement: PromptViewPlacement): void {
    this.active = true;
    this.mode = placement.mode ?? (placement.trigger === FAST_TRIGGER ? 'fast' : 'agent');
    this.dismissedQuery = undefined;
    this.picker = undefined;
    this.busy = false;
    this.preview = '';
    this.error = undefined;
    this.hint = placement.hint === undefined ? undefined : oneLine(placement.hint);
    this.inputRow.paddingLeft = placement.inputCol - 1;
    const color = this.mode === 'fast' ? theme.fast : theme.accent;
    this.marker.content = t`${bold(fg(color)(placement.trigger))} `;
    this.marker.width = displayWidth(placement.trigger) + 1;
    this.textOffset = placement.inputCol - 1 + displayWidth(placement.trigger) + 1;

    const rewriting = placement.rewriting?.trim() ? oneLine(placement.rewriting) : undefined;
    this.placeholders = this.mode === 'agent' ? PLACEHOLDERS.agent : rewriting ? PLACEHOLDERS.rewrite : PLACEHOLDERS.fast;
    this.rewritingRow.visible = rewriting !== undefined;
    if (rewriting !== undefined) {
      this.rewritingRow.content = toStyledText([[
        seg(' '.repeat(this.textOffset)),
        seg('rewriting: ', 'muted'),
        seg(truncateEnd(rewriting, Math.max(4, this.renderer.terminalWidth - this.textOffset - 11)), 'muted'),
      ]]);
    }

    this.input.value = '';
    this.root.visible = true;
    this.input.focus();
    this.refresh();
  }

  close(): void {
    this.active = false;
    this.setBusyState(false);
    this.picker = undefined;
    this.input.blur();
    this.root.visible = false;
  }

  /** Stop timers; call before the renderer is destroyed. */
  destroy(): void {
    this.active = false;
    clearInterval(this.spinnerTimer);
    this.spinnerTimer = undefined;
  }

  /** Where `::` will go, right-aligned on the input row; undefined hides it. */
  setHint(hint: string | undefined): void {
    this.hint = hint === undefined ? undefined : oneLine(hint);
    this.refresh();
  }

  /** Fast mode: the request is running. The text stays, a spinner shows, typing pauses. */
  setBusy(busy: boolean): void {
    if (busy) {
      this.error = undefined;
      this.preview = '';
    }
    this.setBusyState(busy);
    this.refresh();
  }

  /** Fast mode: the reply so far, shown muted beside the request. */
  setPreview(text: string): void {
    this.preview = text;
    this.refresh();
  }

  /** Fast mode: the request failed. One red line; the input is editable again to retry. */
  setError(message: string): void {
    this.error = oneLine(message);
    this.setBusyState(false);
    this.refresh();
  }

  /** Show a list to pick from; the input becomes its filter. */
  openPicker(request: PickerRequest): void {
    this.picker = { ...request, placeholder: oneLine(request.placeholder), emptyText: request.emptyText && oneLine(request.emptyText) };
    this.input.value = '';
    this.refresh();
  }

  closePicker(): void {
    if (!this.picker) {
      return;
    }
    this.picker = undefined;
    this.input.value = '';
    this.refresh();
  }

  private setBusyState(busy: boolean): void {
    this.busy = busy;
    clearInterval(this.spinnerTimer);
    this.spinnerTimer = undefined;
    if (busy) {
      this.input.blur();
      this.spinnerTimer = setInterval(() => {
        if (!this.active) {
          return;
        }
        this.refreshProgress();
        this.renderer.requestRender();
      }, SPINNER_INTERVAL_MS);
    } else if (this.active) {
      // A hidden input does not take focus; show it first.
      this.input.visible = true;
      this.progress.visible = false;
      this.input.focus();
    }
  }

  private submit(value: string): void {
    if (!this.active || this.busy) {
      return;
    }
    if (this.picker) {
      const item = this.list.selected;
      if (item) {
        this.picker.onPick(item);
      }
      return;
    }
    const text = value.trim();
    if (text) {
      this.handlers.onSubmit(text);
    } else {
      this.handlers.onCancel();
    }
  }

  private handleInputChange(): void {
    if (this.error !== undefined) {
      this.error = undefined;
    }
    this.refresh();
  }

  private handleKey(key: KeyEvent): void {
    if (!this.active) {
      return;
    }

    const claim = (action: () => void): void => {
      key.stopPropagation();
      action();
    };

    if (key.ctrl && key.name === 'c') {
      claim(() => this.handlers.onCancel());
      return;
    }

    if (this.busy) {
      // Typing waits for the reply; Escape cancels the request.
      claim(() => {
        if (key.name === 'escape') {
          this.handlers.onCancel();
        }
      });
      return;
    }

    if (this.picker) {
      switch (key.name) {
        case 'up':
          claim(() => this.list.move(-1));
          return;
        case 'down':
        case 'tab':
          claim(() => this.list.move(1));
          return;
        case 'escape':
          claim(() => {
            const picker = this.picker;
            this.closePicker();
            picker?.onClose();
          });
          return;
        case 'backspace':
          if (this.input.value === '') {
            claim(() => {
              const picker = this.picker;
              this.closePicker();
              picker?.onClose();
            });
          }
          return;
      }
      return;
    }

    // Deleting past the start of the input steps back out to the shell.
    if (key.name === 'backspace' && this.input.value === '') {
      claim(() => this.handlers.onCancel());
      return;
    }

    if (this.list.visible && this.list.matchCount > 0) {
      switch (key.name) {
        case 'up':
          claim(() => this.list.move(-1));
          return;
        case 'down':
          claim(() => this.list.move(1));
          return;
        case 'tab':
          claim(() => this.completeSelection());
          return;
        case 'return':
          // Enter runs a command already typed out in full; otherwise it completes the selection.
          claim(() => (this.input.value === this.list.selected?.label
            ? this.submit(this.input.value)
            : this.completeSelection()));
          return;
        case 'escape':
          claim(() => {
            this.dismissedQuery = parseSlashQuery(this.input.value);
            this.refresh();
          });
          return;
      }
    }

    if (key.name === 'escape') {
      claim(() => this.handlers.onCancel());
    }
  }

  private completeSelection(): void {
    const item = this.list.selected;
    if (item) {
      this.input.value = `${item.label} `;
      this.input.gotoLineEnd();
      this.refresh();
    }
  }

  /** Bring everything under and beside the input in line with the current state. */
  private refresh(): void {
    if (!this.active) {
      return;
    }
    this.refreshList();
    this.refreshProgress();
    this.refreshMessage();
    this.refreshHintAndPlaceholder();
  }

  private refreshList(): void {
    const width = this.renderer.terminalWidth;
    if (this.picker) {
      this.list.show(this.picker.items, this.input.value, width, this.textOffset - 2);
    } else {
      const query = parseSlashQuery(this.input.value);
      if (query !== this.dismissedQuery) {
        this.dismissedQuery = undefined;
      }
      if (query === undefined || query === this.dismissedQuery || this.busy) {
        this.list.hide();
      } else {
        const items = this.commands.match(query).map((command): PickerItem => ({
          id: command.name,
          label: `/${command.name}`,
          columns: [command.description],
        }));
        if (items.length === 0) {
          this.list.hide();
        } else {
          this.list.show(items, '', width, this.textOffset - 2);
        }
      }
    }
  }

  /** The room right of the typed text, in cells. */
  private roomAfterText(): number {
    return this.renderer.terminalWidth - this.textOffset - displayWidth(this.input.value) - 1;
  }

  private previewOnOwnRow(): boolean {
    return this.roomAfterText() - 3 < MIN_PREVIEW_CELLS;
  }

  private refreshProgress(): void {
    // While busy the text is drawn as plain text: the input would keep its scroll offset and cut it.
    this.input.visible = !this.busy;
    this.progress.visible = this.busy;
    if (!this.busy) {
      return;
    }
    const value = this.input.value;
    const spinner = seg(spinnerFrame(Date.now()), this.mode === 'fast' ? 'fast' : 'accent');
    const room = this.roomAfterText() - 3;
    const beside = this.preview && !this.previewOnOwnRow() ? [seg(' '), seg(truncateStart(oneLine(this.preview), room), 'muted')] : [];
    this.progress.content = toStyledText([[seg(value), seg(' '), spinner, ...beside]]);
    this.refreshMessage();
  }

  private refreshMessage(): void {
    const width = this.renderer.terminalWidth;
    const indent = seg(' '.repeat(this.textOffset));
    const room = Math.max(4, width - this.textOffset);
    if (this.error !== undefined) {
      this.messageRow.visible = true;
      this.messageRow.content = toStyledText([[indent, seg('✗ ', 'error'), seg(truncateEnd(this.error, room - 2), 'error')]]);
    } else if (this.busy && this.preview && this.previewOnOwnRow()) {
      this.messageRow.visible = true;
      this.messageRow.content = toStyledText([[indent, seg(truncateStart(oneLine(this.preview), room), 'muted')]]);
    } else {
      this.messageRow.visible = false;
    }
  }

  /**
   * The hint shows right-aligned when it fits beside the text (or beside a
   * placeholder, shortened if need be); the placeholder shortens on narrow rows.
   */
  private refreshHintAndPlaceholder(): void {
    const [full, short] = this.picker ? [this.picker.placeholder, this.picker.placeholder.split(' · ')[0]!] : this.placeholders;
    const room = this.renderer.terminalWidth - this.textOffset - 1;
    const typed = displayWidth(this.input.value);
    const hint = this.hint && !this.busy && !this.picker ? this.hint : undefined;
    const hintCells = hint ? displayWidth(hint) + HINT_GAP : 0;

    let placeholder: string = displayWidth(full) <= room ? full : short;
    let showHint = false;
    if (hint) {
      const used = typed > 0 ? typed : displayWidth(placeholder);
      if (used + hintCells <= room) {
        showHint = true;
      } else if (typed === 0 && displayWidth(short) + hintCells <= room) {
        placeholder = short;
        showHint = true;
      }
    }
    this.input.placeholder = placeholder;
    this.hintText.visible = showHint;
    if (hint && showHint) {
      this.hintText.content = toStyledText([[seg(hint, 'muted')]]);
      this.hintText.width = displayWidth(hint);
    }
  }
}
