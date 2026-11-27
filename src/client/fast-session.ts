import type { FastEvent } from '../protocol/schema.js';
import { renderAnswer } from '../ui/agent/static-render.js';
import type { FlowHost, OpenInput } from './flow-host.js';
import { buildFastInput } from './prompt-context.js';
import { echoText, plainText } from './terminal-text.js';

/*
 * Fast mode (`__`, and Ctrl+] on a half-typed command): one quick request to
 * a warm model. A command lands on the shell's input line, unexecuted, with
 * nothing else left on screen; an answer is printed below the request. The
 * line the user was typing is never lost: Esc, an error or an answer puts it
 * back.
 *
 * Requests from one terminal within FOLLOW_UP_MS of each other continue one
 * short conversation ("now make it recursive"); running a command it wrote
 * starts the next request afresh.
 *
 * Privacy: never log the request or the reply.
 */

export const FOLLOW_UP_MS = 2 * 60_000;

interface Request {
  cancelled: boolean;
  iterator: AsyncIterator<FastEvent> | undefined;
}

const tagOf = (error: unknown): string | undefined =>
  typeof error === 'object' && error !== null ? (error as { _tag?: string })._tag : undefined;

/**
 * The reply so far as the preview shows it: without the dressing the final
 * reply loses (a leading `# `, a code fence, a `$ ` prompt sign).
 */
export const cleanPreview = (text: string): string => {
  let clean = text.replace(/^\s+/, '');
  clean = clean.replace(/^```[^\n]*(\n|$)/, '').replace(/\n?`{1,3}\s*$/, '');
  clean = clean.replace(/^#+ ?/, '').replace(/^\$ /, '');
  return clean.trim();
};

export class FastSession {
  private conversation = 0;
  private lastRequestAt = 0;
  /** A command from the current conversation is on the line (or was run). */
  private inserted = false;
  private request: Request | undefined;

  constructor(private readonly host: FlowHost, private readonly terminalId: string) {}

  private get sessionKey(): string {
    return `${this.terminalId}:${this.conversation}`;
  }

  /** The input is open: have a warm worker ready by the time the user presses Enter. */
  opened(): void {
    const link = this.host.link;
    void link.get().then(
      (client) => client.prewarmFast().catch(() => undefined),
      () => {
        if (this.host.overlay.mode === 'fast') {
          this.host.overlay.setError(link.lastError ?? "Shelly's background service is not running.");
        }
      },
    );
  }

  /**
   * Esc (or Ctrl-C): stop the request if one is running, close, and put the
   * user's line back. A request stopped part-way gives up its conversation:
   * the next one starts on a fresh session key, so the two never share a
   * worker, however long the old one takes to wind down.
   */
  cancel(): void {
    const request = this.request;
    if (request) {
      request.cancelled = true;
      // Ends the stream (and so the daemon's request) once it exists; run() does it otherwise.
      void request.iterator?.return?.().catch(() => undefined);
      this.request = undefined;
      this.reset();
    }
    this.host.overlay.close();
    this.host.release({ cursor: 'prompt', line: { type: 'as-before' } });
  }

  /** A command started in the shell: if it is one this conversation wrote, the next request starts afresh. */
  commandStarted(): void {
    if (this.inserted) {
      this.reset();
    }
  }

  submit(open: OpenInput, text: string): void {
    if (text === '' || this.request) {
      return;
    }
    void this.run(open, text);
  }

  private reset(): void {
    const ended = this.sessionKey;
    this.conversation++;
    this.inserted = false;
    void this.host.link.loaded?.endFast(ended).catch(() => undefined);
  }

  private async run(open: OpenInput, text: string): Promise<void> {
    const { overlay, link } = this.host;
    const request: Request = { cancelled: false, iterator: undefined };
    this.request = request;
    overlay.setBusy(true);
    try {
      const client = await link.get();
      if (request.cancelled) {
        return;
      }
      const environment = await this.host.environment();
      if (request.cancelled) {
        return;
      }
      const input = await buildFastInput(this.host.commands, environment, this.host.cwd(), text, open.rewrite?.captured?.buffer ?? '');
      // Esc while getting ready: the request is never sent.
      if (request.cancelled) {
        return;
      }
      if (this.lastRequestAt > 0 && Date.now() - this.lastRequestAt > FOLLOW_UP_MS) {
        this.reset();
      }
      const iterator = client.fastRequest({ sessionKey: this.sessionKey, input })[Symbol.asyncIterator]();
      request.iterator = iterator;
      let reply = '';
      let done: Extract<FastEvent, { type: 'done' }> | undefined;
      for (;;) {
        const next = await iterator.next();
        if (request.cancelled) {
          // Stop listening, which stops the daemon's request and frees its worker.
          await iterator.return?.().catch(() => undefined);
          break;
        }
        if (next.done) {
          break;
        }
        if (next.value.type === 'delta') {
          reply += next.value.text;
          overlay.setPreview(cleanPreview(reply));
        } else {
          done = next.value;
        }
      }
      if (request.cancelled) {
        return;
      }
      this.lastRequestAt = Date.now();
      if (!done) {
        throw new Error('The reply ended before it was complete. Try again.');
      }
      if (done.kind === 'command' && done.text.trim() !== '') {
        this.insert(open, done.text);
      } else {
        await this.answer(open, text, done.text);
      }
    } catch (error) {
      if (!request.cancelled && overlay.isOpen) {
        overlay.setError(describe(error));
      }
    } finally {
      if (this.request === request) {
        this.request = undefined;
      }
    }
  }

  /** The command goes on the shell's line: the input disappears without a trace. */
  private insert(open: OpenInput, command: string): void {
    const { overlay, terminal, colorDepth, lineEditor } = this.host;
    overlay.close();
    if (lineEditor?.canReplace) {
      this.inserted = true;
      this.host.release({ cursor: 'prompt', line: { type: 'set', text: command } });
      return;
    }
    // A shell without Shelly's hooks: show the command to copy rather than type it for the user.
    this.host.claim(() => false);
    terminal.write(echoText(open.trigger, command, 'fast', colorDepth));
    terminal.write(plainText("This shell can't take the command on its line; copy it from above.", colorDepth, 'muted'));
    this.host.release({ cursor: 'fresh-line', line: { type: 'as-before' } });
  }

  /** A short answer, printed below the request; then the prompt, with the user's line as it was. */
  private async answer(open: OpenInput, request: string, answer: string): Promise<void> {
    const { overlay, terminal, colorDepth } = this.host;
    overlay.close();
    this.host.claim(() => false);
    terminal.write(echoText(open.trigger, request, 'fast', colorDepth));
    const text = answer.trim() || '(no answer)';
    try {
      terminal.write(await renderAnswer(text, terminal.size.cols, colorDepth));
    } catch {
      terminal.write(plainText(text, colorDepth));
    }
    this.host.release({ cursor: 'fresh-line', line: { type: 'as-before' } });
  }
}

const describe = (error: unknown): string => {
  switch (tagOf(error)) {
    case 'DaemonDisconnected':
      return "Lost the connection to Shelly's background service · try again";
    default: {
      const message = error instanceof Error ? error.message : String(error);
      return message.split('\n')[0]?.trim() || 'Fast mode failed.';
    }
  }
};
