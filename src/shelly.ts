import { BUILTIN_COMMANDS, CommandRegistry } from './commands/slash-commands.js';
import { CommandLog } from './context/command-log.js';
import { describeEnvironment, type EnvironmentInfo } from './context/environment.js';
import { buildAskContext, formatAskContext } from './context/session-context.js';
import { TriggerDetector, type TriggerAction } from './input/trigger-detector.js';
import { detectColorDepth, type ColorDepth } from './render/sgr.js';
import { LineEditor, type CapturedLine } from './shell/line-editor.js';
import { prepareShellIntegration } from './shell/shell-integration.js';
import { ShellMarkerParser, type ShellOutputSegment } from './shell/shell-markers.js';
import { ShellSession } from './shell/shell-session.js';
import type { CursorPosition } from './terminal/cursor-report.js';
import type { HostTerminal, TerminalSize } from './terminal/host-terminal.js';
import type { InlineOverlay } from './ui/inline-overlay.js';

/** Typed at an empty prompt, these hand the input line to Shelly. */
export const DEFAULT_TRIGGERS = ['::', '__'] as const;

/**
 * Pressed at the prompt, takes the half-typed command to Shelly for a
 * rewrite: Ctrl+] as terminals send it plainly, under the kitty keyboard
 * protocol, and under xterm's modifyOtherKeys (fish turns both on).
 */
export const DEFAULT_REWRITE_HOTKEYS = ['\u001d', '\u001b[93;5u', '\u001b[27;5;93~'] as const;

/** How long a possible trigger's first character is held back before it goes to the shell. */
const TRIGGER_HOLD_MS = 400;
const RESIZE_SETTLE_MS = 50;
/** How long output that might begin a shell marker is held before it goes to the terminal anyway. */
const MARKER_HOLD_MS = 50;
/** A response that takes longer gives the terminal back rather than holding input. */
const RESPONSE_TIMEOUT_MS = 5000;

export interface ShellyOptions {
  readonly host: HostTerminal;
  readonly shell: string;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly triggers?: readonly string[];
  readonly rewriteHotkeys?: readonly string[];
}

/**
 * Where keystrokes go.
 * - shell:   straight to the shell, watching for a trigger.
 * - capturing: the rewrite hotkey was pressed and Shelly is taking the
 *   shell's line; input is queued, but shell output (the cleared line) shows.
 * - opening: a trigger fired and Shelly is getting ready to draw; input is queued.
 * - overlay: to Shelly's input line.
 * - responding: Shelly is writing a response below the prompt; input is
 *   queued (and shell output held) until it is done and the shell has its
 *   line back.
 */
type Mode = 'shell' | 'capturing' | 'opening' | 'overlay' | 'responding';

/**
 * A transparent proxy between the terminal and the user's shell. Until a
 * trigger is typed, every byte passes through untouched in both directions.
 */
export class Shelly {
  private readonly host: HostTerminal;
  private readonly shell: ShellSession;
  private readonly detector: TriggerDetector;
  private readonly colorDepth: ColorDepth;
  /** Reads the shell hooks' markers; absent for shells without hooks. */
  private readonly markers: ShellMarkerParser | undefined;
  /** Reads and sets the shell's input line; absent for shells without hooks. */
  private readonly lineEditor: LineEditor | undefined;
  private readonly rewriteHotkeys: readonly string[];
  /** Set while the input is open for a rewrite: the line taken from the shell, to put back afterwards. */
  private rewrite: { readonly captured: CapturedLine | undefined } | undefined;
  private readonly commands: CommandLog;
  private readonly shellPath: string;
  private readonly env: NodeJS.ProcessEnv;
  /** Looked up in the background once the shell is running. */
  private environment: Promise<EnvironmentInfo> | undefined;
  /** The UI loads in the background so the shell starts without waiting for it. */
  private overlay: InlineOverlay | undefined;
  private overlayLoad: Promise<InlineOverlay | undefined> = Promise.resolve(undefined);
  private overlayUnavailable = false;
  private disposed = false;
  private mode: Mode = 'shell';
  private activeTrigger = '';
  private queuedInput = '';
  /** Shell output that arrives while Shelly owns the input line, replayed when it hands back. */
  private heldShellOutput: string[] = [];
  private triggerHoldTimer: NodeJS.Timeout | undefined;
  private resizeTimer: NodeJS.Timeout | undefined;
  private markerHoldTimer: NodeJS.Timeout | undefined;

  constructor(options: ShellyOptions) {
    this.host = options.host;
    this.shellPath = options.shell;
    this.env = options.env;
    this.colorDepth = detectColorDepth(options.env);
    const lineEditor = new LineEditor({
      write: (data) => this.shell.write(data),
      isShellInForeground: () => this.shell.isShellInForeground(),
    });
    const integration = prepareShellIntegration(options.shell, options.env, undefined, lineEditor.lineFile);
    if (!integration) {
      lineEditor.dispose();
    }
    this.lineEditor = integration && lineEditor;
    this.rewriteHotkeys = options.rewriteHotkeys ?? DEFAULT_REWRITE_HOTKEYS;
    this.markers = integration && new ShellMarkerParser(integration.nonce);
    this.commands = new CommandLog({ columns: () => this.host.size.cols });
    this.shell = ShellSession.spawn({
      shell: options.shell,
      args: integration?.args ?? [],
      cwd: options.cwd,
      env: { ...options.env, ...integration?.env, SHELLY: '1' },
      size: options.host.size,
    });
    this.detector = new TriggerDetector({
      triggers: options.triggers ?? DEFAULT_TRIGGERS,
      isEnabled: () => !this.overlayUnavailable && this.shell.isShellInForeground(),
    });
  }

  /** Proxy the terminal until the shell exits. Resolves with the shell's exit code. */
  run(): Promise<number> {
    return new Promise((resolve) => {
      const stopResizing = this.host.onResize((size) => this.handleResize(size));
      this.shell.onData((data) => this.handleShellOutput(data));
      this.shell.onExit((exitCode) => {
        stopResizing();
        this.dispose();
        resolve(exitCode);
      });
      this.host.start((data) => this.handleInput(data));
      this.overlayLoad = this.loadOverlay();
      this.environment = describeEnvironment(this.shellPath, this.env);
    });
  }

  /** Ask the shell to exit, e.g. on SIGTERM; `run()` resolves once it has. */
  terminate(): void {
    this.shell.kill();
  }

  private async loadOverlay(): Promise<InlineOverlay | undefined> {
    try {
      const { InlineOverlay } = await import('./ui/inline-overlay.js');
      if (this.disposed) {
        return undefined;
      }
      this.overlay = new InlineOverlay(this.host, new CommandRegistry(BUILTIN_COMMANDS), this.colorDepth, {
        onSubmit: (text) => this.handleSubmit(text),
        onCancel: () => this.handleCancel(),
      });
      return this.overlay;
    } catch (error) {
      // Keep working as a plain shell; triggers simply pass through.
      this.overlayUnavailable = true;
      const reason = error instanceof Error ? error.message : String(error);
      process.stderr.write(`shelly: input UI unavailable, running as a plain shell (${reason})\r\n`);
      return undefined;
    }
  }

  private handleInput(data: string): void {
    switch (this.mode) {
      case 'shell':
        this.handleShellInput(data);
        break;
      case 'capturing':
      case 'opening':
      case 'responding':
        this.queuedInput += data;
        break;
      case 'overlay':
        this.overlay?.feed(data);
        break;
    }
  }

  /** Keystrokes for the shell, unless they hold the rewrite hotkey and the shell is at its prompt. */
  private handleShellInput(data: string): void {
    const hotkey = this.overlayUnavailable ? undefined : this.findRewriteHotkey(data);
    if (!hotkey) {
      this.routeToShell(this.detector.push(data));
      return;
    }

    this.routeToShell(this.detector.push(data.slice(0, hotkey.start)));
    if (this.mode !== 'shell') {
      this.queuedInput += data.slice(hotkey.start);
      return;
    }
    if (!this.lineEditor?.isAtPrompt) {
      // What came before it started a command; the rest is that command's.
      this.routeToShell(this.detector.push(data.slice(hotkey.start)));
      return;
    }
    clearTimeout(this.triggerHoldTimer);
    this.writeToShell(this.detector.release());
    void this.startRewrite(data.slice(hotkey.end));
  }

  private findRewriteHotkey(data: string): { start: number; end: number } | undefined {
    if (!this.lineEditor) {
      return undefined;
    }
    let found: { start: number; end: number } | undefined;
    for (const hotkey of this.rewriteHotkeys) {
      const start = data.indexOf(hotkey);
      if (start !== -1 && (!found || start < found.start)) {
        found = { start, end: start + hotkey.length };
      }
    }
    // Asking who owns the terminal costs a system call; only for a hotkey.
    return found && this.lineEditor.isAtPrompt ? found : undefined;
  }

  /** Keystrokes typed for the shell (not ones Shelly sends itself). */
  private writeToShell(data: string): void {
    const filtered = this.lineEditor ? this.lineEditor.filterInput(data) : data;
    if (filtered) {
      this.shell.write(filtered);
    }
  }

  private routeToShell(actions: TriggerAction[]): void {
    clearTimeout(this.triggerHoldTimer);

    for (const action of actions) {
      if (action.type === 'forward') {
        this.writeToShell(action.data);
      } else {
        void this.openOverlay(action.trigger, action.remainder);
        return;
      }
    }

    if (this.detector.isHolding) {
      this.triggerHoldTimer = setTimeout(() => this.writeToShell(this.detector.release()), TRIGGER_HOLD_MS);
    }
  }

  private handleShellOutput(data: string): void {
    if (!this.markers) {
      this.forwardShellOutput(data);
      return;
    }

    clearTimeout(this.markerHoldTimer);
    this.applyShellOutput(this.markers.push(data));
    if (this.markers.isHoldingPartialPrefix) {
      const markers = this.markers;
      this.markerHoldTimer = setTimeout(() => this.applyShellOutput(markers.flush()), MARKER_HOLD_MS);
    }
  }

  private applyShellOutput(segments: ShellOutputSegment[]): void {
    for (const segment of segments) {
      if (segment.type === 'event') {
        this.commands.handle(segment.event);
        this.lineEditor?.handleEvent(segment.event);
      } else {
        this.lineEditor?.observeOutput(segment.data);
        this.commands.recordOutput(segment.data);
        this.forwardShellOutput(segment.data);
      }
    }
  }

  private forwardShellOutput(data: string): void {
    if (this.mode === 'shell' || this.mode === 'capturing') {
      this.host.write(data);
    } else {
      this.heldShellOutput.push(data);
    }
  }

  private async openOverlay(trigger: string, remainder: string): Promise<void> {
    this.mode = 'opening';
    this.activeTrigger = trigger;
    this.queuedInput = remainder;

    const [overlay, cursor] = await Promise.all([
      this.overlayLoad,
      this.host.queryCursorPosition().catch((): CursorPosition | undefined => undefined),
    ]);

    if (!overlay || !cursor || this.disposed) {
      // Nowhere to draw: the keystrokes belong to the shell after all.
      const typed = this.queuedInput;
      this.queuedInput = '';
      this.mode = 'shell';
      this.flushHeldShellOutput();
      if (this.rewrite) {
        this.finishRewrite();
        this.handleInput(typed);
      } else {
        this.writeToShell(trigger + typed);
      }
      return;
    }

    this.mode = 'overlay';
    overlay.open(cursor, trigger, this.queuedInput);
    this.queuedInput = '';
  }

  /** The rewrite hotkey, at the prompt: take the line the user was typing. */
  private async startRewrite(remainder: string): Promise<void> {
    this.mode = 'capturing';
    this.queuedInput = remainder;
    const captured = this.lineEditor?.canCapture ? await this.lineEditor.capture().catch(() => undefined) : undefined;
    if (this.disposed) {
      return;
    }
    this.onRewriteHotkey(captured);
  }

  /**
   * The rewrite hotkey was pressed at the prompt. `captured` is the line the
   * user was typing, now cleared from the shell's input line; undefined when
   * the shell cannot report it, and the line is then left as it is. Until
   * fast mode takes over, this opens the `__` input and puts the line back
   * once it closes.
   */
  private onRewriteHotkey(captured: CapturedLine | undefined): void {
    this.rewrite = { captured };
    void this.openOverlay('__', this.queuedInput);
  }

  /** Put back the line a rewrite took. */
  private finishRewrite(): void {
    const rewrite = this.rewrite;
    this.rewrite = undefined;
    if (!rewrite) {
      return;
    }
    if (rewrite.captured?.buffer) {
      this.lineEditor?.restore(rewrite.captured).catch(() => undefined);
    }
    if (!rewrite.captured || rewrite.captured.buffer) {
      this.detector.markLineUnknown();
    }
  }

  private handleCancel(): void {
    this.overlay?.close();
    this.returnToShell();
    this.finishRewrite();
  }

  private handleSubmit(text: string): void {
    this.overlay?.close();
    this.mode = 'responding';
    this.host.write(`\u001b[1;35m${this.activeTrigger}\u001b[0m ${toTerminalText(text)}\r\n`);
    void Promise.race([
      this.respond(text),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('it took too long')), RESPONSE_TIMEOUT_MS).unref()),
    ])
      .catch((error: unknown) => `Shelly could not answer: ${error instanceof Error ? error.message : String(error)}`)
      .then((response) => {
        if (this.disposed) {
          return;
        }
        this.host.write(`\u001b[90m${toTerminalText(response)}\u001b[0m`);
        // Have the shell draw a fresh prompt below the response, then pass on
        // anything typed in the meantime.
        if (this.rewrite && !this.rewrite.captured) {
          // The line is still on the shell's input line: Enter would run it.
          this.host.write('\r\n');
          this.lineEditor?.redraw();
        } else {
          this.shell.write('\r');
        }
        const typed = this.queuedInput;
        this.queuedInput = '';
        this.returnToShell();
        this.finishRewrite();
        if (typed) {
          this.handleInput(typed);
        }
      });
  }

  /** Agent integration is not built yet; /context shows what it would be told. */
  private async respond(text: string): Promise<string> {
    if (text !== '/context') {
      return "Shelly isn't connected to an agent yet.";
    }
    if (!this.markers) {
      return `Commands are not recorded in ${this.shellPath}; Shelly can hook into zsh, bash and fish.`;
    }
    this.environment ??= describeEnvironment(this.shellPath, this.env);
    return formatAskContext(await buildAskContext(this.commands, await this.environment));
  }

  private returnToShell(): void {
    this.mode = 'shell';
    this.detector.markLineEmpty();
    this.flushHeldShellOutput();
  }

  private flushHeldShellOutput(): void {
    const output = this.heldShellOutput.join('');
    this.heldShellOutput = [];
    this.host.write(output);
  }

  private handleResize(size: TerminalSize): void {
    this.shell.resize(size);
    if (this.mode !== 'overlay') {
      return;
    }

    // Terminals send a burst of resizes while the window is dragged; re-anchor once it settles.
    clearTimeout(this.resizeTimer);
    this.resizeTimer = setTimeout(() => {
      if (this.mode !== 'overlay') {
        return;
      }
      this.host.queryCursorPosition()
        .then((cursor) => this.overlay?.relayout(cursor))
        .catch(() => this.handleCancel());
    }, RESIZE_SETTLE_MS);
  }

  private dispose(): void {
    this.disposed = true;
    clearTimeout(this.triggerHoldTimer);
    clearTimeout(this.resizeTimer);
    clearTimeout(this.markerHoldTimer);
    this.lineEditor?.dispose();
    this.overlay?.destroy();
    this.host.stop();
  }
}

/** Text for the terminal: line breaks as CRLF, and no stray control characters (C0, DEL, C1). */
const toTerminalText = (text: string): string => text
  .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '')
  .replace(/\n/g, '\r\n');
