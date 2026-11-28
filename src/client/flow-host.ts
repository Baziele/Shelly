import type { CommandLog } from '../context/command-log.js';
import type { EnvironmentInfo } from '../context/environment.js';
import type { ColorDepth } from '../render/sgr.js';
import type { CapturedLine, LineEditor } from '../shell/line-editor.js';
import type { HostTerminal } from '../terminal/host-terminal.js';
import type { InlineOverlay } from '../ui/inline-overlay.js';
import type { DaemonLink } from './daemon-link.js';

/*
 * What the agent and fast flows (agent-session.ts, fast-session.ts) need
 * from the terminal wrapper in shelly.ts. Shelly owns the pty, the hooks and
 * where keystrokes go; the flows own what happens after the input opens.
 */

/** The line the shell had before the input opened, when the rewrite hotkey took it. */
export interface Rewrite {
  readonly captured: CapturedLine;
}

/** What the input was opened for. */
export interface OpenInput {
  readonly trigger: string;
  readonly mode: 'agent' | 'fast';
  readonly rewrite: Rewrite | undefined;
}

/** What to leave on the shell's input line when Shelly gives it back. */
export type LineOnReturn =
  /** Nothing: an empty line (or, after a rewrite, the line as the user had it). */
  | { readonly type: 'as-before' }
  /** This text, unexecuted, cursor at the end. */
  | { readonly type: 'set'; readonly text: string };

export interface ReleaseOptions {
  /**
   * Where the cursor is. `prompt`: back at the end of the shell's prompt
   * (the input closed and nothing was printed). `fresh-line`: at the start
   * of an empty line below what Shelly printed, so the shell needs a new
   * prompt, drawn there with no blank line above it.
   */
  readonly cursor: 'prompt' | 'fresh-line';
  readonly line: LineOnReturn;
}

export interface FlowHost {
  readonly terminal: HostTerminal;
  readonly colorDepth: ColorDepth;
  readonly overlay: InlineOverlay;
  readonly link: DaemonLink;
  readonly commands: CommandLog;
  readonly lineEditor: LineEditor | undefined;
  /** The user's home directory, for showing paths with `~`. */
  readonly home: string;
  /** Shelly's config file as the user would type it: `~/.shelly/config.json`. */
  readonly configPath: string;
  /** $SHELLY_HOME, where the client keeps what it last heard about the agents. */
  readonly shellyHome: string;
  /** The shell's working directory now. */
  cwd(): string;
  environment(): Promise<EnvironmentInfo>;
  /** Whether the shell reports its commands (it has Shelly's hooks). */
  readonly recordsCommands: boolean;
  /**
   * Shelly draws below the prompt from now on: keys go to `onKeys` (which
   * says whether it used them; unused keys wait for the shell), and shell
   * output is held until `release`. Only from `open` while it is the input on
   * screen: returns the claim, to give back with `release`, or
   * undefined, taking nothing, once the user has gone back to the shell.
   * Check it before drawing anything.
   */
  claim(open: OpenInput, onKeys: (data: string) => boolean): Claim | undefined;
  /**
   * A one-line note for the user at the shell (a turn finished in the
   * background, say): shown muted below an empty prompt, else above the
   * next one. Gone once they type.
   */
  notice(text: string): void;
  /**
   * Give the terminal back to the shell, then replay what was typed
   * meanwhile. With a claim: only while it is the one holding the terminal
   * (a later claim replaces it). Without: only from the open input.
   */
  release(options: ReleaseOptions, claim?: Claim): void;
}

/** A hold on the terminal, from `claim`. */
export type Claim = number;
