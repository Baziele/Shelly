import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

export interface HistoryEntry {
  command: string;
  output: string;
  startedAt: string;
}

export interface ShellHistory {
  completedAt?: string;
  entries: HistoryEntry[];
  startedAt: string;
}

const stripTerminalControlSequences = (text: string): string => text
  // OSC sequences set terminal titles, hyperlinks, and working-directory
  // metadata. They are not command output.
  .replace(/\u001B\][\s\S]*?(?:\u0007|\u001B\\)/g, '')
  // CSI sequences control colours, cursor movement, and terminal modes.
  .replace(/(?:\u001B\[|\u009B)[0-?]*[ -/]*[@-~]/g, '')
  // Keep line structure, but remove the remaining non-printing controls.
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');

/**
 * Remove the final Zsh prompt redraw. Zsh emits an OSC 7 working-directory
 * sequence immediately before drawing its prompt; commands normally do not.
 */
const removePromptRedraw = (text: string): string => {
  const promptMarker = text.lastIndexOf('\u001B]7;');
  if (promptMarker < 0) {
    return text;
  }

  const zshRedrawStart = text.lastIndexOf('\u001B[1m\u001B[7m%', promptMarker);
  return text.slice(0, zshRedrawStart >= 0 ? zshRedrawStart : promptMarker);
};

const asText = (data: string | Buffer): string => typeof data === 'string'
  ? data
  : data.toString('utf8');

/** Return a unique, portable default location for a shell-session log. */
export const createHistoryLogPath = (workingDirectory = process.cwd()): string => {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  return join(workingDirectory, '.shelly', 'history', `session-${timestamp}-${process.pid}.json`);
};

/**
 * Collects the commands entered into a PTY and the output that follows each
 * command. Call `complete()` after the PTY exits to persist the JSON log.
 */
export class ShellHistoryManager {
  private activeEntry: HistoryEntry | undefined;
  private commandBuffer = '';
  private completed = false;
  private isComposingCommand = false;
  private pendingEcho = '';
  private pendingOutput = '';
  private readonly history: ShellHistory = {
    entries: [],
    startedAt: new Date().toISOString(),
  };

  /** Record bytes typed by the user. A completed line becomes a command. */
  recordInput(data: string | Buffer): void {
    for (const character of asText(data)) {
      if (character === '\r' || character === '\n') {
        if (this.commandBuffer.trim()) {
          this.recordCommand(this.commandBuffer);
        }
        this.commandBuffer = '';
        this.isComposingCommand = false;
        continue;
      }

      if (character === '\b' || character === '\u007f') {
        this.commandBuffer = this.commandBuffer.slice(0, -1);
        this.isComposingCommand = true;
        continue;
      }

      // Ignore terminal-control bytes while retaining printable command text.
      if (character >= ' ') {
        this.commandBuffer += character;
        this.isComposingCommand = true;
      }
    }
  }

  /** Record a command explicitly when the caller has already parsed it. */
  recordCommand(command: string): void {
    if (this.completed || !command.trim()) {
      return;
    }

    this.flushPendingOutput();
    const entry: HistoryEntry = {
      command,
      output: '',
      startedAt: new Date().toISOString(),
    };

    this.history.entries.push(entry);
    this.activeEntry = entry;
    this.isComposingCommand = false;
    this.pendingEcho = command;
  }

  /** Record bytes emitted by the shell after the active command. */
  recordOutput(data: string | Buffer): void {
    if (this.completed || !this.activeEntry || this.isComposingCommand) {
      return;
    }

    const output = stripTerminalControlSequences(removePromptRedraw(asText(data)))
      .replace(/^[\r\n]+/, '');
    if (!output) {
      return;
    }

    if (this.pendingEcho) {
      this.consumeEcho(output);
      return;
    }

    this.activeEntry.output += output;
  }

  /** Return an immutable snapshot suitable for displaying or testing. */
  toJSON(): ShellHistory {
    return {
      entries: this.history.entries.map((entry) => ({ ...entry })),
      startedAt: this.history.startedAt,
      ...(this.history.completedAt ? { completedAt: this.history.completedAt } : {}),
    };
  }

  /** Finish the session and atomically write the JSON history log. */
  async complete(logFile: string): Promise<string> {
    if (!this.completed) {
      this.flushPendingOutput();
      this.history.completedAt = new Date().toISOString();
      this.completed = true;
    }

    const resolvedLogFile = resolve(logFile);
    await mkdir(dirname(resolvedLogFile), { recursive: true });

    const temporaryFile = `${resolvedLogFile}.${process.pid}.tmp`;
    await writeFile(temporaryFile, `${JSON.stringify(this.toJSON(), null, 2)}\n`, 'utf8');
    await rename(temporaryFile, resolvedLogFile);
    return resolvedLogFile;
  }

  private consumeEcho(output: string): void {
    const combined = this.pendingOutput + output;
    const echoedLines = [`${this.pendingEcho}\r\n`, `${this.pendingEcho}\n`];

    for (const echoedLine of echoedLines) {
      if (combined.startsWith(echoedLine)) {
        this.pendingEcho = '';
        this.pendingOutput = '';
        if (this.activeEntry) {
          this.activeEntry.output += combined.slice(echoedLine.length);
        }
        return;
      }
    }

    if (echoedLines.some((echoedLine) => echoedLine.startsWith(combined))) {
      this.pendingOutput = combined;
      return;
    }

    this.pendingEcho = '';
    this.pendingOutput = '';
    if (this.activeEntry) {
      this.activeEntry.output += combined;
    }
  }

  private flushPendingOutput(): void {
    // A partial pending echo is terminal rendering, not command output.
    this.pendingEcho = '';
    this.pendingOutput = '';
  }
}
