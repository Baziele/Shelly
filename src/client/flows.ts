import { randomUUID } from 'node:crypto';
import type { OverlayOpenOptions } from '../ui/inline-overlay.js';
import { AgentSession } from './agent-session.js';
import type { DaemonClient } from './daemon-client.js';
import { FastSession } from './fast-session.js';
import type { FlowHost, OpenInput } from './flow-host.js';

/*
 * What happens once the input is open, by mode: agent mode (`::`) and fast
 * mode (`__`, Ctrl+]). Loaded with the input UI, after the shell is up.
 */
export class Flows {
  readonly agent: AgentSession;
  readonly fast: FastSession;

  constructor(host: FlowHost) {
    this.agent = new AgentSession(host);
    this.fast = new FastSession(host, randomUUID());
  }

  openOptions(open: OpenInput): OverlayOpenOptions {
    if (open.mode === 'fast') {
      const rewriting = open.rewrite?.captured?.buffer;
      return { mode: 'fast', ...(rewriting ? { rewriting } : {}) };
    }
    return { mode: 'agent', ...this.agent.openOptions() };
  }

  opened(open: OpenInput): void {
    if (open.mode === 'fast') {
      this.fast.opened();
    } else {
      this.agent.opened();
    }
  }

  submit(open: OpenInput, text: string): void {
    if (open.mode === 'fast') {
      this.fast.submit(open, text);
    } else {
      this.agent.submit(open, text);
    }
  }

  cancel(open: OpenInput): void {
    if (open.mode === 'fast') {
      this.fast.cancel();
    } else {
      this.agent.cancel();
    }
  }

  /** The shell started a command. */
  commandStarted(): void {
    this.fast.commandStarted();
  }

  /** Something is on screen answering keys (a turn's view). */
  isDrawing(): boolean {
    return this.agent.isDrawing();
  }

  /** The terminal was resized while Shelly draws below the prompt. */
  relayout(): void {
    this.agent.relayout();
  }

  /** The daemon connection is up (loaded with the UI): fetch what the first prompt will need. */
  connected(client: DaemonClient): void {
    void this.agent.connected(client).catch(() => undefined);
  }

  /** Shelly is exiting: stop drawing at once. */
  dispose(): void {
    this.agent.dispose();
  }

  goodbye(client: DaemonClient): Promise<unknown> {
    return this.agent.goodbye(client);
  }
}
