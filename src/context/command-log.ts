import type { ShellEvent } from '../shell/shell-markers.js';
import { CapturedOutput, type OutputSnapshot } from './captured-output.js';
import { redactSecrets } from './redact.js';
import { renderOutput } from './render-output.js';

/** A finished command, as Shelly can describe it to an agent. */
export interface CommandRecord {
  readonly id: number;
  /** As typed, with secrets masked. */
  readonly command: string;
  readonly cwd: string | undefined;
  readonly startedAt: number;
  readonly finishedAt: number;
  readonly exitCode: number | undefined;
  readonly usedFullScreen: boolean;
  /** The output as it looked on screen, with secrets masked. */
  readonly output: string;
}

export interface CommandLogOptions {
  /** Terminal width, used to replay output that redraws itself. */
  readonly columns: () => number;
  readonly maxCommands?: number;
  /** Budget for raw output kept across all commands, in characters. */
  readonly maxStoredChars?: number;
  readonly now?: () => number;
  readonly render?: (snapshot: OutputSnapshot, columns: number) => Promise<string>;
}

interface RunningCommand {
  readonly id: number;
  readonly command: string;
  readonly cwd: string | undefined;
  readonly startedAt: number;
  readonly columns: number;
  /** Absent for commands that are not recorded (a leading space keeps a command private). */
  readonly output: CapturedOutput | undefined;
}

interface Entry {
  readonly record: Omit<CommandRecord, 'output'>;
  /** Kept so the output can be cleaned up again with better rules later. */
  readonly raw: OutputSnapshot;
  readonly columns: number;
  output: string | undefined;
  rendering: Promise<void> | undefined;
}

const DEFAULT_MAX_COMMANDS = 100;
const DEFAULT_MAX_STORED_CHARS = 8 * 1024 * 1024;

/**
 * The shell session's recent commands. Raw output is collected while a
 * command runs and cleaned up as soon as it finishes, in the background, so
 * a later request never waits for it.
 */
export class CommandLog {
  private readonly options: Required<Omit<CommandLogOptions, 'columns'>> & Pick<CommandLogOptions, 'columns'>;
  private readonly entries: Entry[] = [];
  private running: RunningCommand | undefined;
  private nextId = 1;
  private currentCwd: string | undefined;
  private storedChars = 0;

  constructor(options: CommandLogOptions) {
    this.options = {
      maxCommands: DEFAULT_MAX_COMMANDS,
      maxStoredChars: DEFAULT_MAX_STORED_CHARS,
      now: Date.now,
      render: renderOutput,
      ...options,
    };
  }

  /** The shell's working directory, as of its last prompt. */
  get cwd(): string | undefined {
    return this.currentCwd;
  }

  /** True while a command the user ran has not finished yet. */
  get isCommandRunning(): boolean {
    return this.running !== undefined;
  }

  handle(event: ShellEvent): void {
    switch (event.type) {
      case 'exec':
        this.start(event.command);
        break;
      case 'done':
        this.finish(event.exitCode);
        break;
      case 'cwd':
        this.currentCwd = event.path;
        break;
    }
  }

  /** Shell output; only kept while a command is running. */
  recordOutput(data: string): void {
    this.running?.output?.append(data);
  }

  /** Finished commands, oldest first, once their output is cleaned up. */
  async recent(limit = this.options.maxCommands): Promise<CommandRecord[]> {
    const entries = this.entries.slice(-limit);
    await Promise.all(entries.map((entry) => entry.rendering));
    return entries.map((entry) => ({ ...entry.record, output: entry.output ?? '' }));
  }

  async find(id: number): Promise<CommandRecord | undefined> {
    const entry = this.entries.find((candidate) => candidate.record.id === id);
    if (!entry) {
      return undefined;
    }
    await entry.rendering;
    return { ...entry.record, output: entry.output ?? '' };
  }

  private start(command: string): void {
    // A missing `done` (the shell was replaced, say) closes the previous one.
    if (this.running) {
      this.finish(undefined);
    }

    // Empty means the shell ran something it would not name; a leading space
    // is the usual way to keep a command out of history. Respect both.
    const isPrivate = command.trim() === '' || /^\s/.test(command);
    this.running = {
      id: this.nextId++,
      command,
      cwd: this.currentCwd,
      startedAt: this.options.now(),
      columns: this.options.columns(),
      output: isPrivate ? undefined : new CapturedOutput(),
    };
  }

  private finish(exitCode: number | undefined): void {
    const running = this.running;
    this.running = undefined;
    if (!running?.output) {
      return;
    }

    running.output.finish();
    const entry: Entry = {
      record: {
        id: running.id,
        command: redactSecrets(running.command),
        cwd: running.cwd,
        startedAt: running.startedAt,
        finishedAt: this.options.now(),
        exitCode,
        usedFullScreen: running.output.snapshot().usedFullScreen,
      },
      raw: running.output.snapshot(),
      columns: running.columns,
      output: undefined,
      rendering: undefined,
    };
    // Off the output path: the terminal should never wait for this.
    entry.rendering = new Promise<void>((resolve) => setImmediate(resolve)).then(() => this.render(entry));

    this.entries.push(entry);
    this.storedChars += rawSize(entry.raw);
    this.evict();
  }

  private async render(entry: Entry): Promise<void> {
    try {
      entry.output = redactSecrets(await this.options.render(entry.raw, entry.columns));
    } catch {
      entry.output = '[output could not be read]';
    }
  }

  private evict(): void {
    while (
      this.entries.length > this.options.maxCommands
      || (this.storedChars > this.options.maxStoredChars && this.entries.length > 1)
    ) {
      const dropped = this.entries.shift();
      if (dropped) {
        this.storedChars -= rawSize(dropped.raw);
      }
    }
  }
}

const rawSize = (snapshot: OutputSnapshot): number => snapshot.head.length + snapshot.tail.length;
