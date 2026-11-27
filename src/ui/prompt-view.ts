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
  type TextChunk,
} from '@opentui/core';
import { parseSlashQuery, type CommandRegistry, type SlashCommand } from '../commands/slash-commands.js';
import { theme } from './theme.js';

export const MAX_POPUP_ROWS = 6;
/** Tallest the view can get: the input row plus a full popup. */
export const MAX_VIEW_ROWS = 1 + MAX_POPUP_ROWS;

export interface PromptViewHandlers {
  readonly onSubmit: (text: string) => void;
  readonly onCancel: () => void;
}

export interface PromptViewPlacement {
  /** 1-based column where the input row begins; everything left of it belongs to the shell. */
  readonly inputCol: number;
  /** The trigger the user typed, shown as the input's marker. */
  readonly trigger: string;
}

/**
 * Shelly's input line and slash-command popup, built from OpenTUI components.
 * The view lays itself out across the full terminal width; the input row is
 * indented to start where the shell prompt ends.
 */
export class PromptView {
  private readonly root: BoxRenderable;
  private readonly inputRow: BoxRenderable;
  private readonly marker: TextRenderable;
  private readonly input: InputRenderable;
  private readonly popup: BoxRenderable;
  private readonly popupRows: TextRenderable[] = [];
  private active = false;
  private matches: SlashCommand[] = [];
  private selectedIndex = 0;
  /** 0-based column where typed text starts, used to line the popup up under it. */
  private textOffset = 0;
  /** Escape hides the popup until the query changes. */
  private dismissedQuery: string | undefined;

  constructor(
    private readonly renderer: CliRenderer,
    private readonly commands: CommandRegistry,
    private readonly handlers: PromptViewHandlers,
  ) {
    this.root = new BoxRenderable(renderer, { flexDirection: 'column', width: '100%', visible: false });
    this.inputRow = new BoxRenderable(renderer, { flexDirection: 'row', width: '100%', height: 1 });
    this.marker = new TextRenderable(renderer, { content: '' });
    this.input = new InputRenderable(renderer, {
      flexGrow: 1,
      placeholder: 'Ask Shelly anything · / for commands',
      placeholderColor: theme.muted,
      textColor: theme.text,
      focusedTextColor: theme.text,
      backgroundColor: theme.transparent,
      focusedBackgroundColor: theme.transparent,
    });
    this.popup = new BoxRenderable(renderer, { flexDirection: 'column', visible: false });

    for (let index = 0; index < MAX_POPUP_ROWS; index++) {
      const row = new TextRenderable(renderer, { content: '', height: 1 });
      this.popupRows.push(row);
      this.popup.add(row);
    }

    this.inputRow.add(this.marker);
    this.inputRow.add(this.input);
    this.root.add(this.inputRow);
    this.root.add(this.popup);
    renderer.root.add(this.root);

    this.input.on(InputRenderableEvents.INPUT, () => this.refreshPopup());
    this.input.on(InputRenderableEvents.ENTER, (value: string) => this.submit(value));
    // Runs before the focused input sees the key, so popup navigation can claim it.
    renderer.keyInput.prependListener('keypress', (key) => this.handleKey(key));
  }

  /** Rows the view currently occupies on screen. */
  get height(): number {
    return 1 + (this.popup.visible ? this.matches.length : 0);
  }

  get value(): string {
    return this.input.value;
  }

  open(placement: PromptViewPlacement): void {
    this.active = true;
    this.dismissedQuery = undefined;
    this.inputRow.paddingLeft = placement.inputCol - 1;
    this.marker.content = t`${bold(fg(theme.accent)(placement.trigger))} `;
    this.marker.width = placement.trigger.length + 1;
    this.textOffset = placement.inputCol - 1 + placement.trigger.length + 1;
    this.input.value = '';
    this.root.visible = true;
    this.input.focus();
    this.refreshPopup();
  }

  close(): void {
    this.active = false;
    this.input.blur();
    this.root.visible = false;
  }

  private submit(value: string): void {
    if (!this.active) {
      return;
    }
    const text = value.trim();
    if (text) {
      this.handlers.onSubmit(text);
    } else {
      this.handlers.onCancel();
    }
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

    // Deleting past the start of the input steps back out to the shell.
    if (key.name === 'backspace' && this.input.value === '') {
      claim(() => this.handlers.onCancel());
      return;
    }

    if (this.popup.visible) {
      switch (key.name) {
        case 'up':
          claim(() => this.moveSelection(-1));
          return;
        case 'down':
          claim(() => this.moveSelection(1));
          return;
        case 'tab':
        case 'return':
          claim(() => this.completeSelection());
          return;
        case 'escape':
          claim(() => {
            this.dismissedQuery = parseSlashQuery(this.input.value);
            this.refreshPopup();
          });
          return;
      }
    }

    if (key.name === 'escape') {
      claim(() => this.handlers.onCancel());
    }
  }

  private moveSelection(step: number): void {
    const count = this.matches.length;
    this.selectedIndex = (this.selectedIndex + step + count) % count;
    this.renderPopup();
  }

  private completeSelection(): void {
    const command = this.matches[this.selectedIndex];
    if (command) {
      this.input.value = `/${command.name} `;
      this.input.gotoLineEnd();
      this.refreshPopup();
    }
  }

  private refreshPopup(): void {
    const query = parseSlashQuery(this.input.value);
    const matches = query === undefined || query === this.dismissedQuery
      ? []
      : this.commands.match(query).slice(0, MAX_POPUP_ROWS);

    if (query !== this.dismissedQuery) {
      this.dismissedQuery = undefined;
    }

    const changed = matches.length !== this.matches.length
      || matches.some((command, index) => command !== this.matches[index]);
    if (changed) {
      this.matches = matches;
      this.selectedIndex = 0;
    }
    this.renderPopup();
  }

  private renderPopup(): void {
    const visible = this.active && this.matches.length > 0;
    this.popup.visible = visible;
    if (!visible) {
      return;
    }

    const nameWidth = Math.max(...this.matches.map((command) => command.name.length)) + 1;
    const descriptionWidth = Math.max(...this.matches.map((command) => command.description.length));
    // "› " + "/name" + gap + description
    const popupWidth = 2 + nameWidth + 2 + descriptionWidth;
    this.popup.marginLeft = Math.max(0, Math.min(this.textOffset, this.renderer.terminalWidth - popupWidth));

    this.popupRows.forEach((row, index) => {
      const command = this.matches[index];
      row.visible = command !== undefined;
      if (command) {
        row.content = this.formatCommand(command, nameWidth, index === this.selectedIndex);
      }
    });
  }

  private formatCommand(command: SlashCommand, nameWidth: number, selected: boolean) {
    const name = `/${command.name}`.padEnd(nameWidth);
    const indicator: TextChunk = selected ? bold(fg(theme.accent)('›')) : fg(theme.muted)(' ');
    const label: TextChunk = selected ? bold(fg(theme.accent)(name)) : fg(theme.text)(name);
    return t`${indicator} ${label}  ${fg(theme.muted)(command.description)}`;
  }
}
