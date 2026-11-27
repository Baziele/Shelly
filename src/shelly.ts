import { homedir } from 'node:os';
import type { FlowHost, OpenInput, ReleaseOptions } from './client/flow-host.js';
import type { Flows } from './client/flows.js';
import { DaemonLink } from './client/daemon-link.js';
import { BUILTIN_COMMANDS, CommandRegistry } from './commands/slash-commands.js';
import { CommandLog } from './context/command-log.js';
import { describeEnvironment, type EnvironmentInfo } from './context/environment.js';
import { TriggerDetector, type TriggerAction } from './input/trigger-detector.js';
import { detectColorDepth, type ColorDepth } from './render/sgr.js';
import { LineEditor, type CapturedLine, type CaptureResult } from './shell/line-editor.js';
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

/** Shown below the line when the rewrite hotkey could not take it. */
const LINE_UNREADABLE = "Shelly couldn't read the line you were typing; it is left as it was.";
/** How long that notice waits for a busy shell to be back at its prompt; after that, a bell. */
const NOTICE_WAIT_MS = 5000;
const NOTICE_POLL_MS = 100;

/** How long a possible trigger's first character is held back before it goes to the shell. */
const TRIGGER_HOLD_MS = 400;
const RESIZE_SETTLE_MS = 50;
/** How long output that might begin a shell marker is held before it goes to the terminal anyway. */
const MARKER_HOLD_MS = 50;
/** How long the terminal must be quiet (no keys, no output) before the daemon connection loads. */
const IDLE_MS = 300;
/** Longest Shelly waits for a prompt it asked for before carrying on anyway. */
const PROMPT_WAIT_MS = 1500;
const NO_HOOKS_PROMPT_WAIT_MS = 100;
/** Moves the cursor up one row: onto the last line Shelly printed, which the shell's newline then leaves. */
const CURSOR_UP = '\u001b[A';

export interface ShellyOptions {
  readonly host: HostTerminal;
  readonly shell: string;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly triggers?: readonly string[];
  readonly rewriteHotkeys?: readonly string[];
  /** The daemon connection; tests may pass their own. */
  readonly link?: DaemonLink;
}

/**
 * Where keystrokes go.
 * - shell:   straight to the shell, watching for a trigger.
 * - capturing: the rewrite hotkey was pressed and Shelly is taking the
 *   shell's line; input is queued, but shell output (the cleared line) shows.
 * - opening: a trigger fired and Shelly is getting ready to draw; input is queued.
 * - overlay: to Shelly's input line.
 * - busy: Shelly is drawing below the prompt (an agent turn, an answer).
 *   Keys go to what it is drawing, the rest is queued for the shell, and
 *   shell output is held, until the shell has its line back.
 * - returning: Shelly asked the shell for a new prompt and waits for it to
 *   be drawn; input is queued, shell output (the prompt) shows.
 */
type Mode = 'shell' | 'capturing' | 'opening' | 'overlay' | 'busy' | 'returning';

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
  /** What the input was opened for, from the trigger until the shell has its line back. */
  private open: OpenInput | undefined;
  /** Where keys go in `busy` mode; returns whether they were used. */
  private busyKeys: ((data: string) => boolean) | undefined;
  private readonly commands: CommandLog;
  private readonly link: DaemonLink;
  private readonly initialCwd: string;
  private flows: Flows | undefined;
  private warmupStarted = false;
  private warmupTimer: NodeJS.Timeout | undefined;
  private lastActivityAt = 0;
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
  private queuedInput = '';
  /** Shell output that arrives while Shelly owns the input line, replayed when it hands back. */
  private heldShellOutput: string[] = [];
  private triggerHoldTimer: NodeJS.Timeout | undefined;
  private resizeTimer: NodeJS.Timeout | undefined;
  private markerHoldTimer: NodeJS.Timeout | undefined;
  /** Waiting for the shell to draw the prompt Shelly asked for: then this runs. */
  private promptWait: { sawCwd: boolean; readonly run: () => void; readonly timer: NodeJS.Timeout } | undefined;

  constructor(options: ShellyOptions) {
    this.host = options.host;
    this.shellPath = options.shell;
    this.env = options.env;
    this.initialCwd = options.cwd;
    this.link = options.link ?? new DaemonLink({ env: options.env });
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
        void this.dispose().then(() => resolve(exitCode));
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
      const [{ InlineOverlay }, { Flows }] = await Promise.all([import('./ui/inline-overlay.js'), import('./client/flows.js')]);
      if (this.disposed) {
        return undefined;
      }
      const overlay = new InlineOverlay(this.host, new CommandRegistry(BUILTIN_COMMANDS), this.colorDepth, {
        onSubmit: (text) => this.open && this.flows?.submit(this.open, text),
        onCancel: () => this.open && this.flows?.cancel(this.open),
      });
      this.overlay = overlay;
      this.flows = new Flows(this.flowHost(overlay));
      return overlay;
    } catch (error) {
      // Keep working as a plain shell; triggers simply pass through.
      this.overlayUnavailable = true;
      const reason = error instanceof Error ? error.message : String(error);
      process.stderr.write(`shelly: input UI unavailable, running as a plain shell (${reason})\r\n`);
      return undefined;
    }
  }

  /** What the agent and fast flows get to work with. */
  private flowHost(overlay: InlineOverlay): FlowHost {
    return {
      terminal: this.host,
      colorDepth: this.colorDepth,
      overlay,
      link: this.link,
      commands: this.commands,
      lineEditor: this.lineEditor,
      home: this.env.HOME || homedir(),
      recordsCommands: this.markers !== undefined,
      cwd: () => this.commands.cwd ?? this.initialCwd,
      environment: () => (this.environment ??= describeEnvironment(this.shellPath, this.env)),
      claim: (onKeys) => this.claim(onKeys),
      release: (options) => this.release(options),
    };
  }

  private handleInput(data: string): void {
    this.lastActivityAt = Date.now();
    switch (this.mode) {
      case 'shell':
        this.handleShellInput(data);
        break;
      case 'capturing':
      case 'opening':
      case 'returning':
        this.queuedInput += data;
        break;
      case 'busy':
        if (!this.busyKeys?.(data)) {
          this.queuedInput += data;
        }
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
    // A shell that can neither hand over its line nor redraw it below
    // Shelly's output gets the key itself.
    if (!this.lineEditor || !(this.lineEditor.canCapture || this.lineEditor.canRedraw)) {
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
    this.lastActivityAt = Date.now();
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
        if (segment.event.type === 'cwd') {
          this.warmUp();
          if (this.promptWait) {
            this.promptWait.sawCwd = true;
          }
        } else if (segment.event.type === 'exec') {
          this.flows?.commandStarted();
        }
      } else {
        this.lineEditor?.observeOutput(segment.data);
        this.commands.recordOutput(segment.data);
        this.forwardShellOutput(segment.data);
        if (this.promptWait?.sawCwd) {
          // The prompt is being drawn, so the line editor has the terminal again.
          this.promptReady();
        }
      }
    }
  }

  private forwardShellOutput(data: string): void {
    if (this.mode === 'shell' || this.mode === 'capturing' || this.mode === 'returning') {
      this.host.write(data);
    } else {
      this.heldShellOutput.push(data);
    }
  }

  /**
   * The shell has drawn its first prompt: start the daemon now (a spawn, no
   * Effect), and load the connection to it once the terminal is quiet, so
   * its module loading never lands on a keystroke.
   */
  private warmUp(): void {
    if (this.warmupStarted || this.disposed) {
      return;
    }
    this.warmupStarted = true;
    void this.link.startDaemon().catch(() => undefined);
    const whenIdle = (): void => {
      if (this.disposed) {
        return;
      }
      const quietFor = Date.now() - this.lastActivityAt;
      if (quietFor < IDLE_MS) {
        this.warmupTimer = setTimeout(whenIdle, IDLE_MS - quietFor);
        return;
      }
      void this.link.get().then((client) => this.flows?.connected(client), () => undefined);
    };
    this.warmupTimer = setTimeout(whenIdle, IDLE_MS);
  }

  private async openOverlay(trigger: string, remainder: string, rewrite?: OpenInput['rewrite']): Promise<void> {
    this.mode = 'opening';
    this.open = { trigger, mode: trigger === '__' ? 'fast' : 'agent', rewrite };
    this.queuedInput = remainder;

    const [overlay, cursor] = await Promise.all([
      this.overlayLoad,
      this.host.queryCursorPosition().catch((): CursorPosition | undefined => undefined),
    ]);

    const flows = this.flows;
    if (!overlay || !flows || !cursor || this.disposed) {
      // Nowhere to draw: the keystrokes belong to the shell after all.
      const typed = this.queuedInput;
      this.queuedInput = '';
      this.mode = 'shell';
      this.flushHeldShellOutput();
      if (this.open?.rewrite) {
        this.putLineBack(this.open.rewrite);
        this.open = undefined;
        this.handleInput(typed);
      } else {
        this.open = undefined;
        this.writeToShell(trigger + typed);
      }
      return;
    }

    this.mode = 'overlay';
    const open = this.open!;
    overlay.open(cursor, trigger, this.queuedInput, flows.openOptions(open));
    this.queuedInput = '';
    flows.opened(open);
  }

  /** The rewrite hotkey, at the prompt: take the line the user was typing. */
  private async startRewrite(remainder: string): Promise<void> {
    const editor = this.lineEditor!;
    this.mode = 'capturing';
    this.queuedInput = remainder;
    if (!editor.canCapture) {
      // bash 3.2: the line stays on the shell's input line, and is redrawn
      // below anything Shelly prints.
      this.onRewriteHotkey(undefined);
      return;
    }
    const result = await editor.tryCapture().catch((): CaptureResult => ({ status: 'failed', reason: 'no-answer' }));
    if (this.disposed) {
      return;
    }
    if (result.status === 'captured') {
      this.onRewriteHotkey(result.line);
      return;
    }
    // The shell still has the line (or, answering late, has it put back),
    // so the input does not open: say so below the line instead.
    this.mode = 'shell';
    this.detector.markLineUnknown();
    this.flushHeldShellOutput();
    void this.sayLineUnreadable();
    const typed = this.queuedInput;
    this.queuedInput = '';
    if (typed) {
      this.handleInput(typed);
    }
  }

  /**
   * Have the shell show, below its line, that Shelly could not read it. A
   * shell that did not answer may still be busy (in a widget that runs a
   * program, say), so wait for it to be back at its prompt; keys never go
   * to a program it started.
   */
  private async sayLineUnreadable(): Promise<void> {
    const editor = this.lineEditor!;
    for (let waited = 0; !editor.isAtPrompt && waited < NOTICE_WAIT_MS && !this.disposed; waited += NOTICE_POLL_MS) {
      await new Promise((resolve) => setTimeout(resolve, NOTICE_POLL_MS));
    }
    if (this.disposed) {
      return;
    }
    const shown = editor.canNotify && editor.isAtPrompt
      ? await editor.notify(LINE_UNREADABLE).then(() => true, () => false)
      : false;
    if (!shown && !this.disposed) {
      this.host.write('\u0007');
    }
  }

  /**
   * The rewrite hotkey was pressed at the prompt. `captured` is the line the
   * user was typing, now cleared from the shell's input line; undefined when
   * the shell cannot hand its line over (bash 3.2), which then stays where
   * it is. Not called when a capture fails: the line is not Shelly's then.
   * Opens fast mode's input to rewrite it; the line comes back as it was
   * unless a command takes its place.
   */
  private onRewriteHotkey(captured: CapturedLine | undefined): void {
    void this.openOverlay('__', this.queuedInput, { captured });
  }

  /** Put back the line a rewrite took, if it took one. */
  private putLineBack(rewrite: NonNullable<OpenInput['rewrite']>): void {
    if (rewrite.captured?.buffer) {
      this.lineEditor?.restore(rewrite.captured).catch(() => undefined);
    }
    if (!rewrite.captured || rewrite.captured.buffer) {
      this.detector.markLineUnknown();
    }
  }

  /** Shelly draws below the prompt: keys go to `onKeys`, shell output waits. */
  private claim(onKeys: (data: string) => boolean): void {
    this.mode = 'busy';
    this.busyKeys = onKeys;
  }

  /**
   * Give the terminal back to the shell: a fresh prompt if Shelly printed
   * below the old one, the line as it should be, then whatever arrived
   * meanwhile (held output, typed keys) in order.
   */
  private release({ cursor, line }: ReleaseOptions): void {
    if (this.disposed) {
      return;
    }
    const rewrite = this.open?.rewrite;
    this.open = undefined;
    this.busyKeys = undefined;

    // Anything the shell printed meanwhile goes first, on its own lines. A
    // shell idle at its prompt only redraws that prompt (on a resize, say),
    // which the new one replaces: drawn down here, it would show twice.
    let held = this.takeHeldShellOutput();
    if (cursor === 'fresh-line' && !held.includes('\n') && this.lineEditor?.isAtPrompt) {
      held = '';
    }
    if (held) {
      this.host.write(cursor === 'fresh-line' && !held.endsWith('\n') ? `${held}\r\n` : held);
    }

    const finish = (): void => {
      this.mode = 'shell';
      this.detector.markLineEmpty();
      if (line.type === 'set') {
        // Set exactly, cursor at the end; a multi-line command is beyond what the detector follows.
        if (line.text.includes('\n')) {
          this.detector.markLineUnknown();
        } else {
          this.detector.markLineTyped([...line.text].length);
        }
        this.lineEditor?.replace(line.text).catch(() => this.host.write('\u0007'));
      } else if (rewrite) {
        this.putLineBack(rewrite);
      }
      this.flushHeldShellOutput();
      const typed = this.queuedInput;
      this.queuedInput = '';
      if (typed) {
        this.handleInput(typed);
      }
    };

    if (cursor === 'prompt') {
      finish();
    } else if (rewrite && !rewrite.captured) {
      // bash 3.2: the line is still on the shell's input line, where Enter
      // would run it: have the shell redraw prompt and line down here.
      this.lineEditor?.redraw();
      finish();
    } else {
      // Keys sent before the new prompt is up would be echoed by the
      // terminal driver, and a line set then would be lost: wait for it.
      this.mode = 'returning';
      this.whenPromptReady(finish);
      this.freshPrompt();
    }
  }

  private whenPromptReady(run: () => void): void {
    clearTimeout(this.promptWait?.timer);
    // A shell without hooks never says; give it a moment.
    const timer = setTimeout(() => this.promptReady(), this.markers ? PROMPT_WAIT_MS : NO_HOOKS_PROMPT_WAIT_MS);
    this.promptWait = { sawCwd: false, run, timer };
  }

  private promptReady(): void {
    const wait = this.promptWait;
    if (!wait) {
      return;
    }
    this.promptWait = undefined;
    clearTimeout(wait.timer);
    // After this chunk of output has gone to the terminal.
    setImmediate(() => {
      if (!this.disposed) {
        wait.run();
      }
    });
  }

  /**
   * The cursor is at the start of an empty line below Shelly's output, and
   * the shell's line editor still thinks it is at the end of its prompt,
   * further up. Enter on the empty line makes the shell move down one line
   * (from where it thinks it is) and draw a new prompt, so the cursor first
   * goes up onto the last printed line: the prompt lands on the empty line,
   * with no blank line above it.
   */
  private freshPrompt(): void {
    this.host.write(CURSOR_UP);
    this.shell.write('\r');
  }

  private flushHeldShellOutput(): void {
    const output = this.takeHeldShellOutput();
    if (output) {
      this.host.write(output);
    }
  }

  private takeHeldShellOutput(): string {
    const output = this.heldShellOutput.join('');
    this.heldShellOutput = [];
    return output;
  }

  private handleResize(size: TerminalSize): void {
    this.shell.resize(size);
    if (this.mode !== 'overlay' && this.mode !== 'busy') {
      return;
    }

    // Terminals send a burst of resizes while the window is dragged; re-anchor once it settles.
    clearTimeout(this.resizeTimer);
    this.resizeTimer = setTimeout(() => {
      if (this.mode === 'busy') {
        this.flows?.relayout();
        return;
      }
      if (this.mode !== 'overlay') {
        return;
      }
      // A query can fail while another is in flight: try once more, else keep the old anchor.
      const query = () => this.host.queryCursorPosition();
      query()
        .catch(() => query())
        .then((cursor) => this.overlay?.relayout(cursor), () => undefined);
    }, RESIZE_SETTLE_MS);
  }

  private async dispose(): Promise<void> {
    this.disposed = true;
    clearTimeout(this.triggerHoldTimer);
    clearTimeout(this.resizeTimer);
    clearTimeout(this.markerHoldTimer);
    clearTimeout(this.warmupTimer);
    clearTimeout(this.promptWait?.timer);
    this.lineEditor?.dispose();
    this.overlay?.destroy();
    this.host.stop();
    // Detach the thread so another terminal can take it, and close the connection so the process can exit.
    const flows = this.flows;
    await this.link.dispose(flows ? (client) => flows.goodbye(client) : undefined);
  }
}
