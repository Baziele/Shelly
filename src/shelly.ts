import { BUILTIN_COMMANDS, CommandRegistry } from './commands/slash-commands.js';
import { TriggerDetector, type TriggerAction } from './input/trigger-detector.js';
import { detectColorDepth, type ColorDepth } from './render/sgr.js';
import { ShellSession } from './shell/shell-session.js';
import type { CursorPosition } from './terminal/cursor-report.js';
import type { HostTerminal, TerminalSize } from './terminal/host-terminal.js';
import type { InlineOverlay } from './ui/inline-overlay.js';

/** Typed at an empty prompt, these hand the input line to Shelly. */
export const DEFAULT_TRIGGERS = ['::', '__'] as const;

/** How long a possible trigger's first character is held back before it goes to the shell. */
const TRIGGER_HOLD_MS = 400;
const RESIZE_SETTLE_MS = 50;

export interface ShellyOptions {
  readonly host: HostTerminal;
  readonly shell: string;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly triggers?: readonly string[];
}

/**
 * Where keystrokes go.
 * - shell:   straight to the shell, watching for a trigger.
 * - opening: a trigger fired and Shelly is getting ready to draw; input is queued.
 * - overlay: to Shelly's input line.
 */
type Mode = 'shell' | 'opening' | 'overlay';

/**
 * A transparent proxy between the terminal and the user's shell. Until a
 * trigger is typed, every byte passes through untouched in both directions.
 */
export class Shelly {
  private readonly host: HostTerminal;
  private readonly shell: ShellSession;
  private readonly detector: TriggerDetector;
  private readonly colorDepth: ColorDepth;
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

  constructor(options: ShellyOptions) {
    this.host = options.host;
    this.colorDepth = detectColorDepth(options.env);
    this.shell = ShellSession.spawn({
      shell: options.shell,
      cwd: options.cwd,
      env: { ...options.env, SHELLY: '1' },
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
        this.routeToShell(this.detector.push(data));
        break;
      case 'opening':
        this.queuedInput += data;
        break;
      case 'overlay':
        this.overlay?.feed(data);
        break;
    }
  }

  private routeToShell(actions: TriggerAction[]): void {
    clearTimeout(this.triggerHoldTimer);

    for (const action of actions) {
      if (action.type === 'forward') {
        this.shell.write(action.data);
      } else {
        void this.openOverlay(action.trigger, action.remainder);
        return;
      }
    }

    if (this.detector.isHolding) {
      this.triggerHoldTimer = setTimeout(() => this.shell.write(this.detector.release()), TRIGGER_HOLD_MS);
    }
  }

  private handleShellOutput(data: string): void {
    if (this.mode === 'shell') {
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
      this.shell.write(trigger + this.queuedInput);
      this.queuedInput = '';
      this.mode = 'shell';
      this.flushHeldShellOutput();
      return;
    }

    this.mode = 'overlay';
    overlay.open(cursor, trigger, this.queuedInput);
    this.queuedInput = '';
  }

  private handleCancel(): void {
    this.overlay?.close();
    this.returnToShell();
  }

  private handleSubmit(text: string): void {
    this.overlay?.close();
    this.returnToShell();
    // Agent integration is not built yet: record the request, then have the
    // shell draw a fresh prompt below it.
    this.host.write(
      `\u001b[1;35m${this.activeTrigger}\u001b[0m ${text}\r\n`
        + `\u001b[90mShelly isn't connected to an agent yet.\u001b[0m`,
    );
    this.shell.write('\r');
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
    this.overlay?.destroy();
    this.host.stop();
  }
}
