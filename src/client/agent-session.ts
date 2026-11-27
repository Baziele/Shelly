import { BUILTIN_COMMANDS, parseSlashCommand } from '../commands/slash-commands.js';
import { formatCommandLines, formatEnvironmentLines } from '../context/format-context.js';
import type {
  AgentInfo,
  ModeState,
  PromptContext,
  StopReason,
  ThreadEvent,
  ThreadLocation,
  ThreadStatus,
  ThreadSummary,
} from '../protocol/schema.js';
import { AgentView } from '../ui/agent/agent-view.js';
import { renderHistory } from '../ui/agent/history.js';
import { oneLine, seg, type Line } from '../ui/agent/lines.js';
import type { PickerItem } from '../ui/list-picker.js';
import { agentPickerItems, modePickerItems, threadPickerItems } from '../ui/pickers.js';
import { truncateEnd } from '../render/text-width.js';
import type { DaemonClient } from './daemon-client.js';
import type { FlowHost, OpenInput } from './flow-host.js';
import { buildPromptContext, newestCommandId } from './prompt-context.js';
import { echoText, linesText, plainText } from './terminal-text.js';

/*
 * Agent mode (`::`): one current thread per terminal, prompts and their
 * turns drawn inline, turns sent to the background and watched again, and
 * the slash commands. The daemon keeps the threads; this keeps what this
 * terminal knows about them: which one is current, what context each has
 * already been sent, and the turn it is showing.
 *
 * Privacy: never log prompt text or command output.
 */

interface CurrentThread {
  readonly id: string;
  title: string;
  readonly agentId: string;
  readonly location: ThreadLocation;
  status: ThreadStatus;
}

/** One reading of a turn's events: which turn, how far, and how it stands. */
interface Tracker {
  /** What the user asked, for the echo when they come back to watch. */
  text: string;
  turnId: string | undefined;
  /** The seq of its `turn.started`, once seen. */
  startSeq: number | undefined;
  lastSeq: number;
  status: 'running' | 'waiting' | 'ended';
}

/** A turn this terminal started or is following, for as long as it runs. */
interface LiveTurn extends Tracker {
  readonly threadId: string;
  readonly agentId: string;
  /** The view drawing it now; undefined while it runs in the background. */
  view: AgentView | undefined;
}

const newTracker = (text: string, lastSeq: number): Tracker => ({
  text,
  turnId: undefined,
  startSeq: undefined,
  lastSeq,
  status: 'running',
});

/** A finished turn the user sent to the background and has not seen the end of. */
interface UnseenTurn {
  readonly threadId: string;
  readonly agentId: string;
  readonly text: string;
  readonly startSeq: number;
}

type Outcome = 'ended' | 'lost';

const TITLE_IN_HINT = 32;
const LIST_LIMIT = 50;
/** Exchanges of history fetched on a switch: the last, and the running one if there is one. */
const SWITCH_HISTORY_TURNS = 2;

const tagOf = (error: unknown): string | undefined =>
  typeof error === 'object' && error !== null ? (error as { _tag?: string })._tag : undefined;

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error)).split('\n')[0] ?? '';

const synthetic = (event: Record<string, unknown>): ThreadEvent => ({ seq: -1, ...event }) as unknown as ThreadEvent;

export class AgentSession {
  private thread: CurrentThread | undefined;
  /** What the next prompt does about threads: start a new one, and where. */
  private next: { newThread: boolean; here: boolean } = { newThread: false, here: false };
  private agents: readonly AgentInfo[] = [];
  /** The daemon (by pid) this terminal attached the current thread on; a new daemon needs it attached again. */
  private attachedOn: number | undefined;
  /** Per thread, the newest command it has heard about from this terminal. */
  private readonly sentUpTo = new Map<string, number | undefined>();
  private readonly modes = new Map<string, ModeState>();
  private live: LiveTurn | undefined;
  private unseen: UnseenTurn | undefined;
  /** The view on screen now, for resizes. */
  private view: AgentView | undefined;
  /** Bumped when the input closes, so a slow slash command's answer is dropped. */
  private inputGeneration = 0;

  constructor(private readonly host: FlowHost) {}

  // ─── Opening the input ────────────────────────────────────────────────────

  /** Options for `::`: the hint says where the prompt goes; Enter on empty watches a running turn. */
  openOptions(): { readonly hint: string | undefined; readonly submitEmpty: boolean } {
    return { hint: this.hint(), submitEmpty: this.canWatch() };
  }

  /** The input is open: warm the agent while the user types, and say if the daemon is out of reach. */
  opened(): void {
    const generation = this.inputGeneration;
    const link = this.host.link;
    void link.get().then(
      async (client) => {
        if (this.agents.length === 0) {
          this.agents = await client.listAgents();
        }
        const thread = this.next.newThread ? undefined : this.thread;
        // TODO: pass the shell's cwd once thread.prewarm takes one, so a `cd` does not cost a resume.
        void client.prewarmThread(thread ? { threadId: thread.id } : this.nextAgentId() ? { agentId: this.nextAgentId()! } : {})
          .catch(() => undefined);
        if (generation === this.inputGeneration && this.host.overlay.mode === 'agent') {
          this.host.overlay.setHint(this.hint(), this.canWatch());
        }
      },
      () => {
        if (generation === this.inputGeneration && this.host.overlay.mode === 'agent') {
          this.host.overlay.setError(link.lastError ?? "Shelly's background service is not running.");
        }
      },
    );
  }

  /** Esc, Ctrl-C or Backspace past the start: the input closes, nothing happens. */
  cancel(): void {
    this.inputGeneration++;
    this.host.overlay.close();
    this.host.release({ cursor: 'prompt', line: { type: 'as-before' } });
  }

  submit(open: OpenInput, text: string): void {
    if (text === '') {
      this.watchCurrent(open);
      return;
    }
    const command = parseSlashCommand(text);
    if (command) {
      void this.runCommand(open, command.name, command.args).catch((error: unknown) => {
        if (this.host.overlay.isOpen) {
          this.host.overlay.setBusy(false);
          this.host.overlay.setError(this.describeError(error));
        }
      });
      return;
    }
    void this.prompt(open, text);
  }

  // ─── Hints ────────────────────────────────────────────────────────────────

  private defaultAgentId(): string | undefined {
    return this.agents.find((agent) => agent.isDefault)?.id ?? this.agents.find((agent) => agent.available)?.id;
  }

  /** The agent a new thread would use. */
  private nextAgentId(): string | undefined {
    return this.defaultAgentId();
  }

  private canWatch(): boolean {
    return (this.live !== undefined && !this.live.view && this.live.status !== 'ended') || this.unseen !== undefined
      || (this.thread !== undefined && this.thread.status !== 'idle' && this.live === undefined);
  }

  private hint(): string | undefined {
    const live = this.live;
    if (live && !live.view && live.status !== 'ended') {
      return live.status === 'waiting'
        ? `◆ ${live.agentId} is waiting for you · enter to answer`
        : `● ${live.agentId} is working · enter to watch`;
    }
    if (this.unseen) {
      return `✓ ${this.unseen.agentId} finished · enter to see`;
    }
    const thread = this.thread;
    if (thread && !this.next.newThread) {
      if (thread.status !== 'idle' && !live) {
        return `● ${thread.agentId} is working · enter to watch`;
      }
      const mode = this.modeLabel(thread.id);
      const title = thread.title ? `“${truncateEnd(oneLine(thread.title), TITLE_IN_HINT)}”` : 'this thread';
      return `${thread.agentId}${mode ? ` · ${mode}` : ''} · ${title}`;
    }
    const agent = this.nextAgentId();
    if (!agent) {
      return undefined;
    }
    return `${agent} · new thread${this.next.here ? ' here' : ''}`;
  }

  /** The thread's mode, when it is not the agent's first (usual) one. */
  private modeLabel(threadId: string): string | undefined {
    const modes = this.modes.get(threadId);
    if (!modes || modes.availableModes[0]?.id === modes.currentModeId) {
      return undefined;
    }
    return modes.availableModes.find((mode) => mode.id === modes.currentModeId)?.name ?? modes.currentModeId;
  }

  private refreshHint(): void {
    if (this.host.overlay.mode === 'agent') {
      this.host.overlay.setHint(this.hint(), this.canWatch());
    }
  }

  // ─── Prompts ──────────────────────────────────────────────────────────────

  private async prompt(open: OpenInput, text: string): Promise<void> {
    if (this.live?.view) {
      return;
    }
    const view = this.beginOutput(open, text);
    const started = Date.now();
    let client: DaemonClient;
    let threadId: string;
    let context: PromptContext;
    try {
      client = await this.host.link.get();
      if (this.agents.length === 0) {
        this.agents = await client.listAgents();
      }
      const thread = await this.ensureThread(client);
      threadId = thread.id;
      context = await this.contextFor(threadId);
    } catch (error) {
      await this.endView(view, this.describeError(error), started);
      return;
    }

    const live: LiveTurn = { ...newTracker(text, 0), threadId, agentId: this.thread?.agentId ?? 'agent', view };
    this.live = live;
    this.unseen = undefined;
    const stop = this.handleActions(view, client, live);
    try {
      const outcome = await this.follow(client.prompt(threadId, text, context), live, live, view, () => {
        this.sentUpTo.set(threadId, newestCommandId(context, this.sentUpTo.get(threadId)));
      });
      if (outcome === 'lost') {
        await this.recover(live, live, view);
      }
    } catch (error) {
      if (live.view === view && live.status !== 'ended') {
        live.status = 'ended';
        live.view = undefined;
        stop();
        await this.endView(view, this.describeError(error), started, live.turnId);
        this.settled(live);
        return;
      }
      live.status = 'ended';
    } finally {
      stop();
    }
    await this.settle(live, live, view);
  }

  /** Close the input, echo the request and start a view right away, so feedback is immediate. */
  private beginOutput(open: OpenInput, text: string, agentId?: string, note?: string): AgentView {
    this.inputGeneration++;
    const { overlay, terminal, colorDepth } = this.host;
    overlay.close();
    terminal.write(echoText(open.trigger, text, 'agent', colorDepth, note));
    const view = new AgentView(terminal, colorDepth, {
      agentName: agentId ?? (this.thread && !this.next.newThread ? this.thread.agentId : this.nextAgentId()) ?? 'agent',
      cwd: this.host.cwd(),
      home: this.host.home,
    });
    this.view = view;
    this.host.claim((data) => view.handleInput(data));
    void terminal.queryCursorPosition().then(
      (cursor) => view.start(cursor),
      // No answer: start at the bottom row, where the echo most likely left the cursor.
      () => view.start({ row: terminal.size.rows, col: 1 }),
    );
    return view;
  }

  /** Answers, stop and background from the view, sent where they belong. */
  private handleActions(view: AgentView, client: DaemonClient, live: LiveTurn): () => void {
    return view.onAction((action) => {
      switch (action.type) {
        case 'answer':
          void client.respond(live.threadId, action.requestId, action.optionId).catch(() => undefined);
          return;
        case 'cancel':
          void client.cancel(live.threadId).catch(() => undefined);
          return;
        case 'background':
          if (live.view === view) {
            live.view = undefined;
            this.releaseView(view);
          }
          return;
      }
    });
  }

  /**
   * Feed a turn's events to `view` while it is the one showing `live`, until
   * the turn ends. Keeps reading after the user sends it to the background,
   * to know when it ends.
   */
  private async follow(
    events: AsyncIterable<ThreadEvent>,
    tracker: Tracker,
    live: LiveTurn,
    view: AgentView,
    onStarted?: () => void,
  ): Promise<Outcome> {
    try {
      for await (const event of events) {
        tracker.lastSeq = Math.max(tracker.lastSeq, event.seq);
        this.track(tracker, live, event);
        if (event.type === 'turn.started' && event.turnId === tracker.turnId) {
          onStarted?.();
        }
        if (live.view === view) {
          view.apply(event);
        }
        if (event.type === 'turn.ended' && event.turnId === tracker.turnId) {
          return 'ended';
        }
      }
      return 'ended';
    } catch (error) {
      if (tagOf(error) === 'DaemonDisconnected') {
        return 'lost';
      }
      throw error;
    }
  }

  private track(tracker: Tracker, live: LiveTurn, event: ThreadEvent): void {
    switch (event.type) {
      case 'turn.started':
        if (tracker.turnId === undefined) {
          tracker.turnId = event.turnId;
          tracker.startSeq = event.seq;
          tracker.text = event.text;
        }
        return;
      case 'permission.requested':
        tracker.status = 'waiting';
        if (tracker === live) {
          this.noticeIfHidden(live, `${live.agentId} is waiting for you · type :: and press enter to answer`);
          this.refreshHint();
        }
        return;
      case 'permission.resolved':
        tracker.status = 'running';
        this.refreshHint();
        return;
      case 'mode.changed':
        this.modes.set(live.threadId, { currentModeId: event.currentModeId, availableModes: event.availableModes });
        return;
      case 'turn.ended':
        if (event.turnId === tracker.turnId) {
          tracker.status = 'ended';
        }
        return;
      default:
        return;
    }
  }

  /** The daemon went away mid-turn: start it again and catch up, or say what happened. */
  private async recover(tracker: Tracker, live: LiveTurn, view: AgentView): Promise<void> {
    const shown = (): boolean => live.view === view;
    if (shown()) {
      view.apply(synthetic({ type: 'notice', turnId: tracker.turnId ?? null, level: 'warning', text: "Lost the connection to Shelly's background service. Reconnecting…" }));
    }
    try {
      const client = await this.host.link.get();
      const hello = await this.host.link.reconnect();
      await client.attachThread(live.threadId, { historyTurns: 0 });
      this.attachedOn = hello.pid;
      await this.follow(client.watch(live.threadId, tracker.lastSeq), tracker, live, view);
    } catch {
      // Said below.
    }
    if (tracker.status !== 'ended' && shown()) {
      const reason = this.host.link.lastError;
      view.apply(synthetic({
        type: 'turn.ended',
        turnId: tracker.turnId ?? 'lost',
        stopReason: 'interrupted' satisfies StopReason,
        error: `lost the connection to Shelly's background service${reason ? ` (${reason})` : ''}`,
        durationMs: 0,
      }));
    }
    tracker.status = 'ended';
  }

  /** After a stream ends: finish the view if it still shows the turn, else note an unseen result. */
  private async settle(tracker: Tracker, live: LiveTurn, view: AgentView): Promise<void> {
    if (this.thread?.id === live.threadId && tracker.status === 'ended') {
      this.thread.status = 'idle';
    }
    if (live.view === view) {
      live.view = undefined;
      if (tracker.status === 'ended') {
        this.settled(live);
      }
      await view.finish();
      this.releaseView(view);
      return;
    }
    if (live.view === undefined && tracker.status === 'ended') {
      // It finished in the background.
      if (tracker.startSeq !== undefined) {
        this.unseen = { threadId: live.threadId, agentId: live.agentId, text: tracker.text, startSeq: tracker.startSeq };
        this.noticeIfHidden(live, `${live.agentId} finished · type :: and press enter to see`);
      }
      this.settled(live);
    }
    // Otherwise another view (a watch) shows the turn now, and settles it.
  }

  /** The turn is over: this terminal stops tracking it. */
  private settled(live: LiveTurn): void {
    live.status = 'ended';
    if (this.live === live) {
      this.live = undefined;
    }
    void this.refreshThread(live.threadId);
    this.refreshHint();
  }

  /** End a view that never got a turn (the request failed), with the reason as its summary. */
  private async endView(view: AgentView, reason: string, startedAt: number, turnId?: string): Promise<void> {
    view.apply(synthetic({
      type: 'turn.ended',
      turnId: turnId ?? 'failed',
      stopReason: 'error' satisfies StopReason,
      error: reason,
      durationMs: Date.now() - startedAt,
    }));
    await view.finish();
    this.releaseView(view);
  }

  /** The view left the cursor on a fresh line below its output: the shell's prompt goes there. */
  private releaseView(view: AgentView): void {
    if (this.view === view) {
      this.view = undefined;
    }
    this.host.release({ cursor: 'fresh-line', line: { type: 'as-before' } });
  }

  /** A one-line note below the shell's line, when the user is at the prompt and not looking at the turn. */
  private noticeIfHidden(live: LiveTurn, text: string): void {
    const editor = this.host.lineEditor;
    if (live.view || !editor?.canNotify || !editor.isAtPrompt || this.host.overlay.isOpen || this.view) {
      return;
    }
    void editor.notify(text).catch(() => undefined);
  }

  // ─── Watching ─────────────────────────────────────────────────────────────

  /** Enter on an empty input: show the running (or finished, unseen) turn. */
  private watchCurrent(open: OpenInput): void {
    const live = this.live;
    if (live && !live.view && live.status !== 'ended' && live.startSeq !== undefined) {
      void this.watch(open, live, live.startSeq - 1);
      return;
    }
    const unseen = this.unseen;
    if (unseen) {
      this.unseen = undefined;
      const replay: LiveTurn = { ...newTracker(unseen.text, unseen.startSeq - 1), threadId: unseen.threadId, agentId: unseen.agentId, view: undefined };
      void this.watch(open, replay, unseen.startSeq - 1);
      return;
    }
    if (this.thread && this.thread.status !== 'idle') {
      void this.watchOther(open, this.thread);
      return;
    }
    this.cancel();
  }

  /** A thread running elsewhere (or before this terminal took it): find its turn in the history, then watch. */
  private async watchOther(open: OpenInput, thread: CurrentThread): Promise<void> {
    try {
      const client = await this.host.link.get();
      const { history } = await client.attachThread(thread.id, { historyTurns: 1 });
      this.attachedOn = (await client.connect()).pid;
      const started = history.findLast((event) => event.type === 'turn.started');
      const ended = started && history.some((event) => event.type === 'turn.ended' && event.turnId === started.turnId);
      if (!started || ended) {
        thread.status = 'idle';
        this.refreshHint();
        this.host.overlay.setError('Nothing is running in this thread now.');
        return;
      }
      const live: LiveTurn = { ...newTracker(started.text, started.seq - 1), threadId: thread.id, agentId: thread.agentId, view: undefined };
      this.live = live;
      await this.watch(open, live, started.seq - 1);
    } catch (error) {
      this.host.overlay.setError(this.describeError(error));
    }
  }

  /**
   * Show a turn from its start (`afterSeq` is just before its turn.started):
   * stored events, then live ones until it ends. `live` may still be read
   * by the prompt that started it; this view takes over drawing it.
   */
  private async watch(open: OpenInput | undefined, live: LiveTurn, afterSeq: number): Promise<void> {
    const view = open ? this.beginOutput(open, live.text, live.agentId, 'watching') : this.startView(live.agentId);
    const started = Date.now();
    live.view = view;
    if (live.status !== 'ended') {
      this.live = live;
    }
    let client: DaemonClient;
    try {
      client = await this.host.link.get();
    } catch (error) {
      live.view = undefined;
      await this.endView(view, this.describeError(error), started);
      return;
    }
    const stop = this.handleActions(view, client, live);
    // This view's own reading of the turn: the prompt's stream may still be reading it too.
    const tracker = newTracker(live.text, afterSeq);
    try {
      const outcome = await this.follow(client.watch(live.threadId, afterSeq), tracker, live, view);
      if (outcome === 'lost') {
        await this.recover(tracker, live, view);
      } else if (tracker.status !== 'ended' && live.view === view) {
        // The stream ended without the turn's end: nothing was running after all.
        tracker.status = 'ended';
        view.apply(synthetic({ type: 'turn.ended', turnId: tracker.turnId ?? 'watched', stopReason: 'end_turn', error: null, durationMs: Date.now() - started }));
      }
    } catch (error) {
      if (live.view === view) {
        live.view = undefined;
        stop();
        await this.endView(view, this.describeError(error), started, tracker.turnId);
        return;
      }
    } finally {
      stop();
    }
    if (tracker.status === 'ended') {
      live.status = 'ended';
    }
    await this.settle(tracker, live, view);
  }

  /** A view below output already printed (a thread's history), without an echo. */
  private startView(agentId: string): AgentView {
    const { terminal, colorDepth } = this.host;
    const view = new AgentView(terminal, colorDepth, { agentName: agentId, cwd: this.host.cwd(), home: this.host.home });
    this.view = view;
    this.host.claim((data) => view.handleInput(data));
    void terminal.queryCursorPosition().then(
      (cursor) => view.start(cursor),
      () => view.start({ row: terminal.size.rows, col: 1 }),
    );
    return view;
  }

  // ─── Threads ──────────────────────────────────────────────────────────────

  /** The thread the next prompt goes to, created (and attached) on first use. */
  private async ensureThread(client: DaemonClient): Promise<CurrentThread> {
    const hello = await client.connect();
    const current = this.thread;
    if (current && !this.next.newThread) {
      if (this.attachedOn !== hello.pid) {
        // A new daemon (the old one stopped): attachments do not survive it.
        await client.attachThread(current.id, { historyTurns: 0 });
        this.attachedOn = hello.pid;
      }
      return current;
    }
    const agentId = this.nextAgentId();
    const location: ThreadLocation = this.next.here ? 'folder' : 'home';
    const summary = await client.createThread({ ...(agentId ? { agentId } : {}), location, cwd: this.host.cwd() });
    await client.attachThread(summary.id, { historyTurns: 0 });
    if (current) {
      void client.detachThread(current.id).catch(() => undefined);
    }
    this.thread = fromSummary(summary);
    this.attachedOn = hello.pid;
    this.next = { newThread: false, here: false };
    return this.thread;
  }

  private async contextFor(threadId: string): Promise<PromptContext> {
    const environment = await this.host.environment();
    return buildPromptContext(this.host.commands, environment, this.host.cwd(), this.sentUpTo.has(threadId) ? this.sentUpTo.get(threadId) ?? -1 : undefined);
  }

  private async refreshThread(threadId: string): Promise<void> {
    const client = this.host.link.loaded;
    if (!client) {
      return;
    }
    const threads = await client.listThreads(LIST_LIMIT).catch(() => undefined);
    const summary = threads?.find((thread) => thread.id === threadId);
    if (summary && this.thread?.id === threadId) {
      this.thread.title = summary.title;
      this.refreshHint();
    }
  }

  // ─── Slash commands ───────────────────────────────────────────────────────

  private async runCommand(open: OpenInput, name: string, args: string): Promise<void> {
    const overlay = this.host.overlay;
    switch (name) {
      case 'new':
        this.next = { newThread: true, here: false };
        overlay.clearInput();
        this.refreshHint();
        return;
      case 'here':
        this.next = { newThread: true, here: true };
        overlay.clearInput();
        this.refreshHint();
        return;
      case 'threads':
        await this.pickThread(open);
        return;
      case 'agent':
        await this.pickAgent();
        return;
      case 'mode':
        await this.pickMode();
        return;
      case 'rename':
        await this.rename(args);
        return;
      case 'context':
        await this.showContext(open);
        return;
      case 'help':
        this.showHelp(open);
        return;
    }
  }

  /** Run `work` with the input showing a spinner; undefined if the input closed meanwhile. */
  private async busy<T>(work: () => Promise<T>): Promise<T | undefined> {
    const generation = this.inputGeneration;
    const overlay = this.host.overlay;
    overlay.setBusy(true);
    try {
      const result = await work();
      return generation === this.inputGeneration && overlay.isOpen ? result : undefined;
    } finally {
      if (generation === this.inputGeneration && overlay.isOpen) {
        overlay.setBusy(false);
      }
    }
  }

  private async pickThread(open: OpenInput): Promise<void> {
    const loaded = await this.busy(async () => {
      const client = await this.host.link.get();
      return { client, threads: await client.listThreads(LIST_LIMIT) };
    });
    if (!loaded) {
      return;
    }
    const { client, threads } = loaded;
    const overlay = this.host.overlay;
    if (threads.length === 0) {
      overlay.clearInput();
      overlay.setError('No threads yet · your next message starts one.');
      return;
    }
    overlay.openPicker({
      items: threadPickerItems(threads, { cwd: this.host.cwd(), home: this.host.home, ...(this.thread ? { currentThreadId: this.thread.id } : {}) }),
      placeholder: 'Pick a thread · type to filter',
      emptyText: 'No thread matches',
      onPick: (item) => {
        const summary = threads.find((thread) => thread.id === item.id);
        if (summary) {
          void this.switchTo(open, client, summary, false).catch((error: unknown) => this.failInInput(error));
        }
      },
      onClose: () => undefined,
    });
  }

  private failInInput(error: unknown): void {
    const overlay = this.host.overlay;
    if (overlay.isOpen) {
      overlay.closePicker();
      overlay.setBusy(false);
      overlay.setError(this.describeError(error));
    }
  }

  private async switchTo(open: OpenInput, client: DaemonClient, summary: ThreadSummary, force: boolean): Promise<void> {
    const overlay = this.host.overlay;
    let attached: Awaited<ReturnType<DaemonClient['attachThread']>>;
    try {
      attached = await client.attachThread(summary.id, { force, historyTurns: SWITCH_HISTORY_TURNS });
    } catch (error) {
      if (tagOf(error) !== 'ThreadBusy' || force) {
        throw error;
      }
      overlay.openPicker({
        items: [
          { id: 'take', label: 'Take it over', columns: ['it is open in another terminal'] },
          { id: 'cancel', label: 'Leave it' },
        ] satisfies PickerItem[],
        placeholder: `“${oneLine(summary.title) || 'Untitled thread'}” is open in another terminal`,
        onPick: (item) => {
          if (item.id === 'take') {
            void this.switchTo(open, client, summary, true).catch((failure: unknown) => this.failInInput(failure));
          } else {
            overlay.closePicker();
          }
        },
        onClose: () => undefined,
      });
      return;
    }

    const previous = this.thread;
    if (previous && previous.id !== summary.id) {
      void client.detachThread(previous.id).catch(() => undefined);
    }
    const thread = fromSummary(attached.thread);
    this.thread = thread;
    this.next = { newThread: false, here: false };
    this.attachedOn = (await client.connect()).pid;
    if (this.unseen && this.unseen.threadId !== thread.id) {
      this.unseen = undefined;
    }
    for (const event of attached.history) {
      if (event.type === 'mode.changed') {
        this.modes.set(thread.id, { currentModeId: event.currentModeId, availableModes: event.availableModes });
      }
    }

    // The last finished exchange, then, if a turn is running, that turn live.
    const running = attached.history.findLast((event) => event.type === 'turn.started');
    const runningEnded = running && attached.history.some((event) => event.type === 'turn.ended' && event.turnId === running.turnId);
    const isRunning = thread.status !== 'idle' && running !== undefined && !runningEnded;
    const before = isRunning ? attached.history.filter((event) => event.seq < running.seq) : attached.history;

    this.inputGeneration++;
    overlay.close();
    this.host.claim(() => false);
    const { terminal, colorDepth } = this.host;
    terminal.write(echoText(open.trigger, '/threads', 'agent', colorDepth));
    const hasEarlier = before.some((event) => event.type === 'turn.started');
    if (!isRunning || hasEarlier) {
      terminal.write(await renderHistory(before, {
        agentName: thread.agentId,
        title: thread.title || 'Untitled thread',
        updatedAt: attached.thread.updatedAt,
        cwd: this.host.cwd(),
        home: this.host.home,
        width: terminal.size.cols,
        colorDepth,
      }));
    }
    if (isRunning) {
      const live: LiveTurn = { ...newTracker(running.text, running.seq - 1), threadId: thread.id, agentId: thread.agentId, view: undefined };
      terminal.write(echoText(open.trigger, running.text, 'agent', colorDepth, 'watching'));
      await this.watch(undefined, live, running.seq - 1);
      return;
    }
    this.host.release({ cursor: 'fresh-line', line: { type: 'as-before' } });
  }

  private async pickAgent(): Promise<void> {
    const loaded = await this.busy(async () => {
      const client = await this.host.link.get();
      return { client, agents: await client.listAgents() };
    });
    if (!loaded) {
      return;
    }
    const { client, agents } = loaded;
    this.agents = agents;
    const overlay = this.host.overlay;
    overlay.openPicker({
      items: agentPickerItems(agents),
      placeholder: 'Pick the agent for new threads · type to filter',
      onPick: (item) => {
        const agent = agents.find((candidate) => candidate.id === item.id);
        if (!agent) {
          return;
        }
        overlay.closePicker();
        if (!agent.available) {
          overlay.setError(agent.unavailableReason ?? `${agent.name} can't be used right now.`);
          return;
        }
        void client.setDefaultAgent(agent.id).then(
          () => {
            this.agents = agents.map((candidate) => ({ ...candidate, isDefault: candidate.id === agent.id }));
            if (this.thread && this.thread.agentId !== agent.id) {
              // The next message goes to the new agent, in a new thread.
              this.next = { newThread: true, here: this.next.here };
            }
            this.refreshHint();
          },
          (error: unknown) => this.failInInput(error),
        );
      },
      onClose: () => undefined,
    });
  }

  private async pickMode(): Promise<void> {
    const loaded = await this.busy(async () => {
      const client = await this.host.link.get();
      if (this.agents.length === 0) {
        this.agents = await client.listAgents();
      }
      // Modes belong to a thread's session; with none yet, this starts the thread the next message goes to.
      const thread = await this.ensureThread(client);
      const modes = await client.threadModes(thread.id);
      if (modes) {
        this.modes.set(thread.id, modes);
      }
      return { client, thread, modes };
    });
    if (!loaded) {
      return;
    }
    const { client, thread, modes } = loaded;
    const overlay = this.host.overlay;
    this.refreshHint();
    if (!modes || modes.availableModes.length === 0) {
      overlay.clearInput();
      overlay.setError(`${thread.agentId} has no modes to choose from.`);
      return;
    }
    overlay.openPicker({
      items: modePickerItems(modes.availableModes, modes.currentModeId),
      placeholder: `Pick a mode for ${thread.agentId} · type to filter`,
      onPick: (item) => {
        overlay.closePicker();
        void client.setMode(thread.id, item.id).then(
          () => {
            this.modes.set(thread.id, { ...modes, currentModeId: item.id });
            this.refreshHint();
          },
          (error: unknown) => this.failInInput(error),
        );
      },
      onClose: () => undefined,
    });
  }

  private async rename(title: string): Promise<void> {
    const overlay = this.host.overlay;
    if (!title) {
      overlay.setError('Give it a name: /rename <title>');
      return;
    }
    const thread = this.next.newThread ? undefined : this.thread;
    if (!thread) {
      overlay.setError('No thread yet · your next message starts one.');
      return;
    }
    const done = await this.busy(async () => {
      const client = await this.host.link.get();
      await client.rename(thread.id, title);
      return true;
    });
    if (done) {
      thread.title = title.replace(/\s+/g, ' ').trim();
      overlay.clearInput();
      this.refreshHint();
    }
  }

  /** What the agent gets with the next message: where the shell is, and the commands it has not heard about. */
  private async showContext(open: OpenInput): Promise<void> {
    const { overlay, terminal, colorDepth } = this.host;
    this.inputGeneration++;
    overlay.close();
    this.host.claim(() => false);
    terminal.write(echoText(open.trigger, '/context', 'agent', colorDepth));
    if (!this.host.recordsCommands) {
      terminal.write(plainText("This shell doesn't report its commands to Shelly; Shelly hooks into zsh, bash and fish.", colorDepth, 'muted'));
      this.host.release({ cursor: 'fresh-line', line: { type: 'as-before' } });
      return;
    }
    const thread = this.next.newThread ? undefined : this.thread;
    const context = await this.contextFor(thread?.id ?? '');
    const target = thread ? `${thread.agentId} · “${oneLine(thread.title) || 'this thread'}”` : `${this.nextAgentId() ?? 'the agent'} · new thread`;
    const lines = [
      `With your next message (${target}):`,
      '',
      ...formatEnvironmentLines(context.environment, context.cwd),
      '',
      ...(context.commands.length === 0
        ? [thread ? 'No new commands since your last message.' : 'No commands run yet.']
        : formatCommandLines(context.commands)),
    ];
    while (lines.at(-1) === '') {
      lines.pop();
    }
    terminal.write(plainText(lines.join('\n'), colorDepth));
    this.host.release({ cursor: 'fresh-line', line: { type: 'as-before' } });
  }

  private showHelp(open: OpenInput): void {
    const { overlay, terminal, colorDepth } = this.host;
    this.inputGeneration++;
    overlay.close();
    this.host.claim(() => false);
    terminal.write(echoText(open.trigger, '/help', 'agent', colorDepth));
    const key = (name: string, text: string): Line => [seg(`  ${name.padEnd(10)}`, 'accent', { bold: true }), seg(text)];
    const lines: Line[] = [
      key('::', 'ask your agent, or hand it a task (in a thread you can come back to)'),
      key('__', 'describe a command; it lands on your prompt, ready to edit or run'),
      key('ctrl+]', 'rewrite the command you are typing'),
      [],
      ...BUILTIN_COMMANDS.map((command) => key(`/${command.name}`, command.description)),
      [],
      [seg('  While the agent works: ', 'muted'), seg('esc', 'accent'), seg(' background · ', 'muted'), seg('ctrl+c', 'accent'),
        seg(' stop · ', 'muted'), seg('y n 1-9', 'accent'), seg(' answer a permission', 'muted')],
    ];
    terminal.write(linesText(lines, colorDepth));
    this.host.release({ cursor: 'fresh-line', line: { type: 'as-before' } });
  }

  // ─── Errors and leaving ───────────────────────────────────────────────────

  private describeError(error: unknown): string {
    switch (tagOf(error)) {
      case 'ThreadBusy':
        return 'That thread is open in another terminal · /threads to take it over';
      case 'ThreadNotFound':
        this.thread = undefined;
        return 'That thread no longer exists · your next message starts a new one';
      case 'TurnInProgress':
        return `${this.thread?.agentId ?? 'The agent'} is still working on the last request · enter on an empty :: to watch`;
      case 'DaemonDisconnected':
        return "Lost the connection to Shelly's background service · try again";
      default:
        return messageOf(error) || 'Something went wrong.';
    }
  }

  /** Detach on exit, so another terminal can take the thread without asking. */
  goodbye(client: DaemonClient): Promise<unknown> {
    return this.thread ? client.detachThread(this.thread.id) : Promise.resolve();
  }

  /** The terminal was resized (and has settled) while Shelly draws below the prompt. */
  relayout(): void {
    void this.view?.relayout();
  }
}

const fromSummary = (summary: ThreadSummary): CurrentThread => ({
  id: summary.id,
  title: summary.title,
  agentId: summary.agentId,
  location: summary.location,
  status: summary.status,
});
