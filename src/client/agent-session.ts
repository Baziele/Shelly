import { randomUUID } from 'node:crypto';
import { BUILTIN_COMMANDS, parseSlashCommand, unknownSlashCommand } from '../commands/slash-commands.js';
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
import { AgentView, type AgentAction } from '../ui/agent/agent-view.js';
import { UNKNOWN_AGENT } from '../ui/agent/format.js';
import { renderHistory } from '../ui/agent/history.js';
import { oneLine, seg, type Line } from '../ui/agent/lines.js';
import type { PickerItem } from '../ui/list-picker.js';
import { agentPickerItems, modePickerItems, threadPickerItems, turnedOffReason } from '../ui/pickers.js';
import { fallbackAgentName } from '../protocol/agent-names.js';
import { truncateEnd } from '../render/text-width.js';
import type { DaemonClient } from './daemon-client.js';
import type { Claim, FlowHost, OpenInput } from './flow-host.js';
import { buildPromptContext, newestCommandId } from './prompt-context.js';
import { echoText, errorText, linesText, plainText } from './terminal-text.js';

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
  /** The agent said or did something in this turn (text, a tool call, a plan). */
  answered: boolean;
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
  answered: false,
});

/** A finished turn the user sent to the background and has not seen the end of. */
interface UnseenTurn {
  readonly threadId: string;
  readonly agentId: string;
  readonly text: string;
  readonly startSeq: number;
}

type Outcome = 'ended' | 'lost';

/**
 * Shelly's hold on the terminal while this session prints or draws below
 * the prompt. Keys go to whatever draws now; giving it back is once only.
 */
interface Hold {
  readonly claim: Claim;
  keys: (data: string) => boolean;
  released: boolean;
}

/**
 * A turn's view on screen and what the user asked of it, from its first
 * moment: Esc and Ctrl-C work before the turn exists, and are honoured
 * once it does.
 */
interface Output {
  readonly view: AgentView;
  readonly hold: Hold;
  /** Where its answers and stops go, once there is a turn. */
  target: { readonly client: DaemonClient; readonly threadId: string } | undefined;
  /** The turn it shows, once there is one (Esc moves it to the background). */
  live: LiveTurn | undefined;
  /** Ctrl-C: a turn not sent yet never is; one on its way is stopped as soon as the daemon takes it. */
  cancelled: boolean;
  /** Esc before the turn existed: the prompt is back, and the turn goes ahead out of sight. */
  backgrounded: boolean;
}

/** What the next prompt does about threads: start a new one, where, and in which mode. */
interface NextThread {
  readonly newThread: boolean;
  readonly here: boolean;
  /** Picked with /mode before the thread existed: set when it is created. */
  readonly modeId?: string;
}

const TITLE_IN_HINT = 32;

/*
 * One phrasing for getting back to a turn: in the input (`::` is already
 * typed) "enter to see"; anywhere else ":: then enter to see".
 */
const SEE = 'enter to see';
const SEE_FROM_SHELL = ':: then enter to see';
const ANSWER_FROM_SHELL = ':: then enter to answer';
/** How stale the agent list may get before opening :: refreshes it (in the background). */
const AGENTS_REFRESH_MS = 30_000;
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
  private next: NextThread = { newThread: false, here: false };
  /** The modes each agent offers, as this terminal last saw them: /mode for a new thread needs no thread to show them. */
  private readonly agentModes = new Map<string, ModeState>();
  private agents: readonly AgentInfo[] = [];
  private agentsAt = 0;
  /** The daemon (by pid) this terminal attached the current thread on; a new daemon needs it attached again. */
  private attachedOn: number | undefined;
  /** Per thread, the newest command it has heard about from this terminal. */
  private readonly sentUpTo = new Map<string, number | undefined>();
  private readonly modes = new Map<string, ModeState>();
  /** Per thread, the mode the user last saw reported, so only changes are shown. */
  private readonly shownModes = new Map<string, string>();
  private live: LiveTurn | undefined;
  /** A request getting its thread ready, before the daemon has a turn for it. */
  private starting: Output | undefined;
  private unseen: UnseenTurn | undefined;
  /** The view on screen now, for resizes. */
  private view: AgentView | undefined;
  /** Bumped when the input closes, so a slow slash command's answer is dropped. */
  private inputGeneration = 0;
  /** A line naming no command, already questioned in this input: Enter again sends it as a message. */
  private questioned: { readonly text: string; readonly generation: number } | undefined;

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
          await this.refreshAgents(client);
        } else if (Date.now() - this.agentsAt > AGENTS_REFRESH_MS) {
          // In the background: an agent installed or signed in since shows up without /agent.
          void this.refreshAgents(client).then(() => {
            if (generation === this.inputGeneration && this.host.overlay.mode === 'agent') {
              this.host.overlay.setHint(this.hint(), this.canWatch());
            }
          }, () => undefined);
        }
        const thread = this.next.newThread ? undefined : this.thread;
        // With the shell's directory, so the session is ready for where the prompt comes from (no resume after a `cd`).
        const cwd = this.host.cwd();
        const agentId = this.nextAgentId();
        void client.prewarmThread(thread ? { threadId: thread.id, cwd } : agentId ? { agentId, cwd } : { cwd })
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
    ).catch((error: unknown) => {
      // The daemon answered the connection but not the agent list (it went away, say): say so, in the input.
      if (generation === this.inputGeneration && this.host.overlay.mode === 'agent') {
        this.host.overlay.setError(this.describeError(error));
      }
    });
  }

  /** The input this flow started from is still the one open: nothing closed it since `generation`. */
  private stillOpen(generation: number): boolean {
    return generation === this.inputGeneration && this.host.overlay.isOpen;
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
    const unknown = command ? undefined : unknownSlashCommand(text);
    if (unknown && !(this.questioned?.text === text && this.questioned.generation === this.inputGeneration)) {
      // Most likely a typo for a command: ask before it goes to the agent as a message.
      this.questioned = { text, generation: this.inputGeneration };
      this.host.overlay.setError(
        `Unknown command /${unknown.name}${unknown.suggestion ? ` · did you mean /${unknown.suggestion}?` : ''} · enter again to send it as a message`,
      );
      return;
    }
    this.questioned = undefined;
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

  /** The name the user reads for an agent: the daemon's (a configured `name` wins), else the built-in's, else the id. */
  private nameOf(agentId: string): string {
    return this.agents.find((agent) => agent.id === agentId)?.name ?? fallbackAgentName(agentId);
  }

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
        ? `◆ ${this.nameOf(live.agentId)} is waiting for you · enter to answer`
        : `● ${this.nameOf(live.agentId)} is working · ${SEE}`;
    }
    if (this.unseen) {
      return `✓ ${this.nameOf(this.unseen.agentId)} finished · ${SEE}`;
    }
    const thread = this.thread;
    if (thread && !this.next.newThread) {
      if (thread.status !== 'idle' && !live) {
        return `● ${this.nameOf(thread.agentId)} is working · ${SEE}`;
      }
      const mode = this.modeLabel(thread.id);
      // A thread with no message yet (started by /mode, say) is still a new thread to the user.
      const title = thread.title ? `“${truncateEnd(oneLine(thread.title), TITLE_IN_HINT)}”` : 'new thread';
      return `${this.nameOf(thread.agentId)}${mode ? ` · ${mode}` : ''} · ${title}`;
    }
    const agent = this.nextAgentId();
    if (!agent) {
      // Known to be none (not merely not heard yet): say so, and where to look.
      return this.agentsAt > 0 ? 'no agent set up · /agent' : undefined;
    }
    const info = this.agents.find((candidate) => candidate.id === agent);
    if (info && !info.available) {
      // Enter would only say why: say it before.
      return `${this.nameOf(agent)} · ${unavailableLabel(info)}`;
    }
    const known = this.agentModes.get(agent);
    const mode = this.next.modeId && known ? labelOf({ ...known, currentModeId: this.next.modeId }) : undefined;
    return `${this.nameOf(agent)}${mode ? ` · ${mode}` : ''} · new thread${this.next.here ? ' here' : ''}`;
  }

  /** The thread's mode, when it is not the agent's first (usual) one. */
  private modeLabel(threadId: string): string | undefined {
    return labelOf(this.modes.get(threadId));
  }

  private rememberModes(threadId: string, agentId: string, modes: ModeState): void {
    this.modes.set(threadId, modes);
    // The agent's modes, with its usual one current: what a new thread starts in.
    this.agentModes.set(agentId, { ...modes, currentModeId: this.agentModes.get(agentId)?.currentModeId ?? modes.availableModes[0]?.id ?? modes.currentModeId });
  }

  private refreshHint(): void {
    if (this.host.overlay.mode === 'agent') {
      this.host.overlay.setHint(this.hint(), this.canWatch());
    }
  }

  // ─── Prompts ──────────────────────────────────────────────────────────────

  private async prompt(open: OpenInput, text: string): Promise<void> {
    const running = this.live;
    if (running && running.status !== 'ended') {
      // One turn at a time per terminal: a second would be refused by the daemon (same thread)
      // or lose track of this one. The input stays open, with what the user typed.
      if (!running.view) {
        this.host.overlay.setError(`${this.nameOf(running.agentId)} is still working on your last request · empty the line, then ${SEE}`);
      }
      return;
    }
    if (this.starting?.backgrounded) {
      // Sent to the background before its thread was ready: it is still on its way (and may make the thread).
      this.host.overlay.setError('Still sending your last request · try again in a moment');
      return;
    }
    const output = this.beginOutput(open, text);
    if (!output) {
      return;
    }
    this.starting = output;
    try {
      await this.send(output, text);
    } finally {
      if (this.starting === output) {
        this.starting = undefined;
      }
    }
  }

  /** Make the thread ready, send the request and follow its turn, in `output`. */
  private async send(output: Output, text: string): Promise<void> {
    const { view } = output;
    const started = Date.now();
    // What to go back to should this prompt start a thread that never gets a turn.
    const before = { thread: this.thread, next: this.next };
    let client: DaemonClient | undefined;
    let threadId: string;
    let context: PromptContext;
    let created: CurrentThread | undefined;
    try {
      client = await this.host.link.get();
      if (this.agents.length === 0) {
        await this.refreshAgents(client);
      }
      const thread = await this.ensureThread(client);
      created = thread === before.thread ? undefined : thread;
      view.setAgentName(this.nameOf(thread.agentId));
      threadId = thread.id;
      context = await this.contextFor(threadId);
    } catch (error) {
      if (client && created) {
        this.discardThread(client, created, before);
      }
      // No agent ran: the reason is the whole story, with no time and no agent to check.
      view.setAgentName(UNKNOWN_AGENT);
      await this.endView(output, this.describeError(error), started);
      return;
    }
    if (output.cancelled) {
      // Ctrl-C while the thread was being made ready: the request is never sent.
      await this.endView(output, undefined, started);
      return;
    }

    const live: LiveTurn = { ...newTracker(text, 0), threadId, agentId: this.thread?.agentId ?? 'agent', view: output.backgrounded ? undefined : view };
    output.target = { client, threadId };
    output.live = live;
    // Names this request alone: the turn it starts says so, and a lost stream finds it by that (see recover).
    const requestId = randomUUID();
    const onStarted = (): void => {
      // The daemon took the turn: from here this terminal tracks it (not before, so a refused
      // prompt never replaces a turn that is still running).
      this.turnTaken(live, context);
      if (this.starting === output) {
        this.starting = undefined;
      }
      if (output.cancelled) {
        // Ctrl-C while the daemon was taking it: stop it now that there is something to stop.
        void client.cancel(threadId).catch(() => undefined);
      }
    };
    try {
      const outcome = await this.follow(client.prompt(threadId, text, context, requestId), live, live, view, onStarted);
      if (outcome === 'lost') {
        await this.recover(live, live, view, { requestId, onStarted });
      }
    } catch (error) {
      const neverStarted = live.startSeq === undefined;
      // Only a refusal that says the turn never began (the agent could not be started): any other
      // failure may have left a turn running in the thread.
      const refused = tagOf(error) === 'AgentUnavailable' || tagOf(error) === 'AgentFailed';
      if (neverStarted && refused && created) {
        // A thread with no turn in it would only clutter /threads; the retry starts it again.
        this.discardThread(client, created, before);
      }
      if (live.view === view && live.status !== 'ended') {
        live.status = 'ended';
        live.view = undefined;
        output.target = undefined;
        if (neverStarted && tagOf(error) !== 'AgentFailed') {
          // Refused before any agent ran (it can't be used, the thread is busy): no time, no agent to check.
          view.setAgentName(UNKNOWN_AGENT);
        }
        await this.endView(output, this.describeError(error), started, live.turnId);
        this.settled(live);
        return;
      }
      live.status = 'ended';
      if (live.turnId === undefined) {
        // Refused out of sight (Esc came first): the user is at their prompt, so tell them there.
        this.notifyHidden(`✗ ${this.describeError(error)}`);
      }
    } finally {
      output.target = undefined;
    }
    await this.settle(live, live, output);
  }

  /** The daemon took a turn this terminal sent: track it, and count its context as heard. */
  private turnTaken(live: LiveTurn, context: PromptContext): void {
    this.live = live;
    this.unseen = undefined;
    if (this.thread?.id === live.threadId) {
      this.thread.status = 'running';
    }
    this.sentUpTo.set(live.threadId, newestCommandId(context, this.sentUpTo.get(live.threadId)));
    this.refreshHint();
  }

  /**
   * Take the terminal from the open input, close it, echo the request and
   * start a view right away, so feedback is immediate. Undefined, drawing
   * nothing, if the input is no longer Shelly's to take from.
   */
  private beginOutput(open: OpenInput, text: string, agentId?: string, note?: string): Output | undefined {
    const hold = this.take(open);
    if (!hold) {
      return undefined;
    }
    this.inputGeneration++;
    const { overlay, terminal, colorDepth } = this.host;
    overlay.close();
    terminal.write(echoText(open.trigger, text, 'agent', colorDepth, note));
    return this.showView(hold, this.nameOrUnknown(agentId ?? (this.thread && !this.next.newThread ? this.thread.agentId : this.nextAgentId())));
  }

  /** Claim the terminal from `open`, if it is still the input on screen. */
  private take(open: OpenInput): Hold | undefined {
    let hold: Hold | undefined;
    const claim = this.host.claim(open, (data) => hold?.keys(data) ?? false);
    if (claim === undefined) {
      return undefined;
    }
    hold = { claim, keys: () => false, released: false };
    return hold;
  }

  /** The prompt comes back on a fresh line below what was drawn; once per hold. */
  private giveBack(hold: Hold): void {
    if (hold.released) {
      return;
    }
    hold.released = true;
    this.host.release({ cursor: 'fresh-line', line: { type: 'as-before' } }, hold.claim);
  }

  /** A view drawn under `hold`, listening to the user from its first moment. */
  private showView(hold: Hold, agentName: string): Output {
    const { terminal, colorDepth } = this.host;
    const view = new AgentView(terminal, colorDepth, { agentName, cwd: this.host.cwd(), home: this.host.home });
    const output: Output = { view, hold, target: undefined, live: undefined, cancelled: false, backgrounded: false };
    this.view = view;
    hold.keys = (data) => view.handleInput(data);
    view.onAction((action) => this.act(output, action));
    void terminal.queryCursorPosition().then(
      (cursor) => view.start(cursor),
      // No answer: start at the bottom row, where the echo most likely left the cursor.
      () => view.start({ row: terminal.size.rows, col: 1 }),
    );
    return output;
  }

  /** Answers, stop and background from the view, sent where they belong, or kept until there is a turn. */
  private act(output: Output, action: AgentAction): void {
    const { view, target, live } = output;
    switch (action.type) {
      case 'answer':
        if (target) {
          void target.client.respond(target.threadId, action.requestId, action.optionId).catch(() => undefined);
        }
        return;
      case 'cancel':
        output.cancelled = true;
        if (target) {
          void target.client.cancel(target.threadId).catch(() => undefined);
        }
        return;
      case 'background':
        if (live && live.view !== view) {
          return;
        }
        if (live) {
          live.view = undefined;
        } else {
          output.backgrounded = true;
        }
        // The view writes its note and closes right after telling us; give the prompt back after that.
        setImmediate(() => this.releaseView(output));
        return;
    }
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
        if (live.view === view && this.shows(event, live.threadId)) {
          if (event.type === 'turn.ended' && event.stopReason === 'end_turn' && !tracker.answered) {
            // A bare "✓ 0s" would look like success; an agent that cannot work (not signed in, say) can end this way.
            view.apply(synthetic({
              type: 'notice',
              turnId: event.turnId,
              level: 'warning',
              text: `${this.nameOf(live.agentId)} ended the turn without a reply. If it keeps happening, check that ${this.nameOf(live.agentId)} works on its own.`,
            }));
          }
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

  /**
   * Whether the view shows an event. A thread's first mode report is not a
   * change (the agent starts in its usual mode), so it says nothing.
   */
  private shows(event: ThreadEvent, threadId: string): boolean {
    if (event.type !== 'mode.changed') {
      return true;
    }
    const known = this.shownModes.get(threadId);
    this.shownModes.set(threadId, event.currentModeId);
    return known !== undefined && known !== event.currentModeId;
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
      case 'message.chunk':
      case 'tool.updated':
      case 'plan.updated':
        tracker.answered = true;
        return;
      case 'permission.requested':
        tracker.answered = true;
        tracker.status = 'waiting';
        if (tracker === live) {
          this.noticeIfHidden(live, `${this.nameOf(live.agentId)} is waiting for you · ${ANSWER_FROM_SHELL}`);
          this.refreshHint();
        }
        return;
      case 'permission.resolved':
        tracker.status = 'running';
        this.refreshHint();
        return;
      case 'mode.changed':
        this.rememberModes(live.threadId, live.agentId, { currentModeId: event.currentModeId, availableModes: event.availableModes });
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

  /**
   * The daemon went away mid-turn: start it again and catch up, or say what
   * happened. A request lost before the daemon said it took it is looked
   * for in the thread (`sent`), by the id it went with: found, it is
   * followed from its start; not found, the user is told it may never have
   * reached the agent. Never a
   * replay of the thread from its beginning, which would show an old turn
   * as this one's answer.
   */
  private async recover(
    tracker: Tracker,
    live: LiveTurn,
    view: AgentView,
    sent?: { readonly requestId: string; readonly onStarted: () => void },
  ): Promise<void> {
    const shown = (): boolean => live.view === view;
    if (shown()) {
      view.apply(synthetic({ type: 'notice', turnId: tracker.turnId ?? null, level: 'warning', text: "Lost the connection to Shelly's background service. Reconnecting…" }));
    }
    let unsent = false;
    try {
      const client = await this.host.link.get();
      const hello = await this.host.link.reconnect();
      const lookFor = sent !== undefined && tracker.turnId === undefined;
      const { history } = await client.attachThread(live.threadId, { historyTurns: lookFor ? 1 : 0 });
      this.attachedOn = hello.pid;
      if (lookFor) {
        const newest = history.findLast((event) => event.type === 'turn.started');
        // By its id alone. A daemon that does not echo ids cannot say which turn is this one (the
        // same prompt sent just before looks the same, and the clocks may differ): never guess.
        if (newest?.clientRequestId === undefined || newest.clientRequestId !== sent.requestId) {
          unsent = true;
        } else {
          await this.follow(client.watch(live.threadId, newest.seq - 1), tracker, live, view, sent.onStarted);
        }
      } else {
        await this.follow(client.watch(live.threadId, tracker.lastSeq), tracker, live, view);
      }
    } catch {
      // Said below.
    }
    if (tracker.status !== 'ended' && shown()) {
      const reason = this.host.link.lastError;
      view.apply(synthetic({
        type: 'turn.ended',
        turnId: tracker.turnId ?? 'lost',
        stopReason: 'interrupted' satisfies StopReason,
        error: unsent || tracker.turnId === undefined
          // One line: say the part that matters first.
          ? `connection lost before ${this.nameOf(live.agentId)} started · it may not have your request`
          : `lost the connection to Shelly's background service${reason ? ` (${reason})` : ''}`,
        durationMs: 0,
      }));
    }
    tracker.status = 'ended';
  }

  /** After a stream ends: finish the view if it still shows the turn, else note an unseen result. */
  private async settle(tracker: Tracker, live: LiveTurn, output: Output): Promise<void> {
    const { view } = output;
    if (this.thread?.id === live.threadId && tracker.status === 'ended') {
      this.thread.status = 'idle';
    }
    if (live.view === view) {
      live.view = undefined;
      if (tracker.status === 'ended') {
        this.settled(live);
      }
      try {
        await view.finish();
      } finally {
        this.releaseView(output);
      }
      return;
    }
    if (live.view === undefined && tracker.status === 'ended') {
      // It finished in the background.
      if (tracker.startSeq !== undefined) {
        this.unseen = { threadId: live.threadId, agentId: live.agentId, text: tracker.text, startSeq: tracker.startSeq };
        this.noticeIfHidden(live, `${this.nameOf(live.agentId)} finished · ${SEE_FROM_SHELL}`);
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

  /**
   * End a view that never got a turn, with the reason as its summary (no
   * reason: the user stopped it first). A view the terminal never placed
   * prints the reason as plain text; one sent to the background says it
   * below the prompt.
   */
  private async endView(output: Output, reason: string | undefined, startedAt: number, turnId?: string): Promise<void> {
    const { view, hold } = output;
    const { terminal, colorDepth } = this.host;
    try {
      if (hold.released) {
        view.destroy();
        if (reason) {
          this.notifyHidden(`✗ ${reason}`);
        }
      } else {
        view.apply(synthetic({
          type: 'turn.ended',
          turnId: turnId ?? 'failed',
          stopReason: (reason === undefined ? 'cancelled' : 'error') satisfies StopReason,
          error: reason ?? null,
          durationMs: Date.now() - startedAt,
        }));
        // Waits for the view to start if the terminal has not said where the cursor is yet.
        await view.finish();
        if (!view.hasStarted) {
          // It never did: the reason as plain text, where the view would have been.
          terminal.write(reason ? errorText(reason, colorDepth) : plainText('Stopped.', colorDepth, 'muted'));
        }
      }
    } finally {
      this.releaseView(output);
    }
  }

  /** The view left the cursor on a fresh line below its output: the shell's prompt goes there. */
  private releaseView(output: Output): void {
    if (this.view === output.view) {
      this.view = undefined;
    }
    this.giveBack(output.hold);
  }

  /** A one-line note below the shell's line, when the user is at the prompt and not looking at the turn. */
  private noticeIfHidden(live: LiveTurn, text: string): void {
    if (!live.view) {
      this.notifyHidden(text);
    }
  }

  private notifyHidden(text: string): void {
    const editor = this.host.lineEditor;
    if (!editor?.canNotify || !editor.isAtPrompt || this.host.overlay.isOpen || this.view) {
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
    const generation = this.inputGeneration;
    try {
      const client = await this.host.link.get();
      const { history } = await client.attachThread(thread.id, { historyTurns: 1 });
      this.attachedOn = (await client.connect()).pid;
      if (!this.stillOpen(generation)) {
        // The user closed the input meanwhile and is back at the shell: nothing to show them now.
        return;
      }
      const started = history.findLast((event) => event.type === 'turn.started');
      const ended = started && history.some((event) => event.type === 'turn.ended' && event.turnId === started.turnId);
      if (!started || ended) {
        thread.status = 'idle';
        this.refreshHint();
        this.host.overlay.setError('Nothing is running in this thread now.');
        return;
      }
      const live: LiveTurn = { ...newTracker(started.text, started.seq - 1), threadId: thread.id, agentId: thread.agentId, view: undefined };
      await this.watch(open, live, started.seq - 1);
    } catch (error) {
      if (this.stillOpen(generation)) {
        this.host.overlay.setError(this.describeError(error));
      }
    }
  }

  /**
   * Show a turn from its start (`afterSeq` is just before its turn.started):
   * stored events, then live ones until it ends. `live` may still be read
   * by the prompt that started it; this view takes over drawing it. From
   * the open input (echoing the request), or under a hold already taken
   * (below a thread's history).
   */
  private async watch(from: OpenInput | Hold, live: LiveTurn, afterSeq: number): Promise<void> {
    const output = 'trigger' in from
      ? this.beginOutput(from, live.text, live.agentId, 'watching')
      : this.showView(from, this.nameOf(live.agentId));
    if (!output) {
      return;
    }
    const { view } = output;
    const started = Date.now();
    output.live = live;
    live.view = view;
    if (live.status !== 'ended') {
      this.live = live;
    }
    let client: DaemonClient;
    try {
      client = await this.host.link.get();
    } catch (error) {
      if (live.view === view) {
        live.view = undefined;
      }
      await this.endView(output, this.describeError(error), started);
      return;
    }
    output.target = { client, threadId: live.threadId };
    if (output.cancelled) {
      // Ctrl-C while connecting.
      void client.cancel(live.threadId).catch(() => undefined);
    }
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
        output.target = undefined;
        await this.endView(output, this.describeError(error), started, tracker.turnId);
        return;
      }
    } finally {
      output.target = undefined;
    }
    if (tracker.status === 'ended') {
      live.status = 'ended';
    }
    await this.settle(tracker, live, output);
  }

  /** The view's name for an agent; none known means no agent ran (none is set up, say). */
  private nameOrUnknown(agentId: string | undefined): string {
    return agentId ? this.nameOf(agentId) : UNKNOWN_AGENT;
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
    const modeId = this.next.modeId;
    this.next = { newThread: false, here: false };
    if (modeId) {
      // The mode picked before the thread existed. Should the agent refuse it, the thread still starts.
      await client.setMode(summary.id, modeId).then(
        () => {
          const modes = this.agentModes.get(summary.agentId);
          if (modes) {
            this.rememberModes(summary.id, summary.agentId, { ...modes, currentModeId: modeId });
          }
        },
        () => undefined,
      );
    }
    return this.thread;
  }

  /**
   * Forget a thread this terminal just made for a prompt that never became a
   * turn: delete it and go back to what came before.
   */
  private discardThread(client: DaemonClient, thread: CurrentThread, before: { readonly thread: CurrentThread | undefined; readonly next: NextThread }): void {
    if (this.thread?.id === thread.id) {
      this.thread = before.thread;
      this.next = before.next;
      // Making the new thread let go of the old one: attach it again before its next prompt.
      this.attachedOn = undefined;
      this.refreshHint();
    }
    this.sentUpTo.delete(thread.id);
    void client.deleteThread(thread.id).catch(() => undefined);
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
        this.next = { newThread: true, here: false, ...(this.next.modeId ? { modeId: this.next.modeId } : {}) };
        overlay.clearInput();
        this.refreshHint();
        return;
      case 'here':
        this.next = { newThread: true, here: true, ...(this.next.modeId ? { modeId: this.next.modeId } : {}) };
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
        await this.showHelp(open);
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
      items: threadPickerItems(threads, {
        cwd: this.host.cwd(),
        home: this.host.home,
        agentName: (agentId) => this.nameOf(agentId),
        ...(this.thread ? { currentThreadId: this.thread.id } : {}),
      }),
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
    const generation = this.inputGeneration;
    let attached: Awaited<ReturnType<DaemonClient['attachThread']>>;
    let hello: Awaited<ReturnType<DaemonClient['connect']>>;
    try {
      attached = await client.attachThread(summary.id, { force, historyTurns: SWITCH_HISTORY_TURNS });
      hello = await client.connect();
    } catch (error) {
      if (!this.stillOpen(generation)) {
        return;
      }
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
    if (!this.stillOpen(generation)) {
      // The user closed the input while the thread came, and is back at the shell: no switch.
      if (summary.id !== this.thread?.id) {
        void client.detachThread(summary.id).catch(() => undefined);
      }
      return;
    }

    const previous = this.thread;
    if (previous && previous.id !== summary.id) {
      void client.detachThread(previous.id).catch(() => undefined);
    }
    const thread = fromSummary(attached.thread);
    this.thread = thread;
    this.next = { newThread: false, here: false };
    this.attachedOn = hello.pid;
    if (this.unseen && this.unseen.threadId !== thread.id) {
      this.unseen = undefined;
    }
    for (const event of attached.history) {
      if (event.type === 'mode.changed') {
        this.rememberModes(thread.id, thread.agentId, { currentModeId: event.currentModeId, availableModes: event.availableModes });
      }
    }

    // The last finished exchange, then, if a turn is running, that turn live.
    const running = attached.history.findLast((event) => event.type === 'turn.started');
    const runningEnded = running && attached.history.some((event) => event.type === 'turn.ended' && event.turnId === running.turnId);
    const isRunning = thread.status !== 'idle' && running !== undefined && !runningEnded;
    const before = isRunning ? attached.history.filter((event) => event.seq < running.seq) : attached.history;

    const { terminal, colorDepth } = this.host;
    const renderBefore = async (): Promise<string> =>
      !isRunning || before.some((event) => event.type === 'turn.started')
        ? renderHistory(before, {
          agentName: this.nameOf(thread.agentId),
          title: thread.title || 'Untitled thread',
          updatedAt: attached.thread.updatedAt,
          cwd: this.host.cwd(),
          home: this.host.home,
          width: terminal.size.cols,
          colorDepth,
        })
        : '';
    if (!isRunning) {
      await this.printBelow(open, '/threads', renderBefore);
      return;
    }
    // The history, then the running turn live: the view takes over the terminal from here.
    const hold = this.take(open);
    if (!hold) {
      return;
    }
    this.inputGeneration++;
    overlay.close();
    const interrupted = this.interruptible(hold);
    try {
      terminal.write(echoText(open.trigger, '/threads', 'agent', colorDepth));
      const history = await renderBefore().catch((error: unknown) => errorText(this.describeError(error), colorDepth));
      if (interrupted()) {
        // Ctrl-C while the history came: the prompt is back already; the turn goes on, out of sight.
        return;
      }
      terminal.write(history);
      const live: LiveTurn = { ...newTracker(running.text, running.seq - 1), threadId: thread.id, agentId: thread.agentId, view: undefined };
      terminal.write(echoText(open.trigger, running.text, 'agent', colorDepth, 'watching'));
      await this.watch(hold, live, running.seq - 1);
    } catch (error) {
      if (!hold.released) {
        terminal.write(errorText(this.describeError(error), colorDepth));
      }
      this.giveBack(hold);
    }
  }

  /**
   * While Shelly prints under `hold`, Ctrl-C gives the prompt back at once
   * (what was still to come is dropped). Returns whether it did.
   */
  private interruptible(hold: Hold): () => boolean {
    let interrupted = false;
    hold.keys = (data) => {
      if (!data.includes('\u0003')) {
        return false;
      }
      if (!interrupted) {
        interrupted = true;
        // Not from inside the key handler: Shelly is still dispatching this read.
        setImmediate(() => this.giveBack(hold));
      }
      return true;
    };
    return () => interrupted;
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
    this.agentsAt = Date.now();
    const overlay = this.host.overlay;
    const usable = agents.some((agent) => agent.available);
    overlay.openPicker({
      items: agentPickerItems(agents, { configPath: this.host.configPath }),
      placeholder: usable ? 'Pick the agent for new threads · type to filter' : 'No agent can be used yet · type to filter',
      emptyText: 'No agent matches',
      note: usable
        ? `To add an agent: "agents" in ${this.host.configPath}`
        : `Install Claude Code or OpenCode, or add an agent to "agents" in ${this.host.configPath}`,
      onPick: (item) => {
        const agent = agents.find((candidate) => candidate.id === item.id);
        overlay.closePicker();
        if (!agent) {
          // A built-in agent the config turned off.
          overlay.setError(turnedOffReason(item.label, this.host.configPath));
          return;
        }
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

  /**
   * The current thread's modes, or, for the thread the next message starts,
   * the agent's: picked now, set when the thread is created. Looking never
   * leaves a thread behind.
   */
  private async pickMode(): Promise<void> {
    const loaded = await this.busy(async () => {
      const client = await this.host.link.get();
      if (this.agents.length === 0) {
        await this.refreshAgents(client);
      }
      const thread = this.next.newThread ? undefined : this.thread;
      if (thread) {
        if (this.attachedOn !== (await client.connect()).pid) {
          await client.attachThread(thread.id, { historyTurns: 0 });
        }
        const modes = await client.threadModes(thread.id);
        if (modes) {
          this.rememberModes(thread.id, thread.agentId, modes);
        }
        return { client, agentId: thread.agentId, thread, modes };
      }
      const agentId = this.nextAgentId() ?? 'agent';
      const modes = this.agentModes.get(agentId) ?? await this.learnAgentModes(client);
      return { client, agentId, thread: undefined, modes };
    });
    if (!loaded) {
      return;
    }
    const { client, agentId, thread, modes } = loaded;
    const overlay = this.host.overlay;
    this.refreshHint();
    if (!modes || modes.availableModes.length === 0) {
      overlay.clearInput();
      overlay.setError(`${this.nameOf(agentId)} has no modes to choose from.`);
      return;
    }
    const current = thread ? modes.currentModeId : this.next.modeId ?? modes.currentModeId;
    overlay.openPicker({
      items: modePickerItems(modes.availableModes, current),
      placeholder: `Pick a mode for ${this.nameOf(agentId)} · type to filter`,
      onPick: (item) => {
        overlay.closePicker();
        if (!thread) {
          // Kept for the thread the next message starts.
          this.next = { ...this.next, modeId: item.id };
          this.refreshHint();
          return;
        }
        void client.setMode(thread.id, item.id).then(
          () => {
            this.rememberModes(thread.id, thread.agentId, { ...modes, currentModeId: item.id });
            this.refreshHint();
          },
          (error: unknown) => this.failInInput(error),
        );
      },
      onClose: () => undefined,
    });
  }

  /**
   * The modes the next thread's agent offers. ACP reports modes with a
   * session, so this opens one in a thread made for the purpose, and
   * deletes that thread at once.
   */
  private async learnAgentModes(client: DaemonClient): Promise<ModeState | null> {
    const agentId = this.nextAgentId();
    const probe = await client.createThread({ ...(agentId ? { agentId } : {}), location: 'home', cwd: this.host.cwd() });
    try {
      await client.attachThread(probe.id, { historyTurns: 0 });
      const modes = await client.threadModes(probe.id);
      if (modes) {
        this.agentModes.set(probe.agentId, modes);
      }
      return modes;
    } finally {
      await client.deleteThread(probe.id).catch(() => undefined);
    }
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

  /**
   * Print below the prompt, closing the input first. Whatever happens while
   * rendering (an error included, shown inline), the prompt comes back: the
   * terminal is never left with Shelly. Ctrl-C meanwhile gives it back at once.
   */
  private async printBelow(open: OpenInput, echo: string, render: () => Promise<string> | string): Promise<void> {
    const { overlay, terminal, colorDepth } = this.host;
    const hold = this.take(open);
    if (!hold) {
      return;
    }
    this.inputGeneration++;
    overlay.close();
    const interrupted = this.interruptible(hold);
    terminal.write(echoText(open.trigger, echo, 'agent', colorDepth));
    let text: string;
    try {
      text = await render();
    } catch (error) {
      text = errorText(this.describeError(error), colorDepth);
    }
    if (!interrupted()) {
      terminal.write(text);
      this.giveBack(hold);
    }
  }

  /** What the agent gets with the next message: where the shell is, and the commands it has not heard about. */
  private showContext(open: OpenInput): Promise<void> {
    const { colorDepth } = this.host;
    return this.printBelow(open, '/context', async () => {
      if (!this.host.recordsCommands) {
        return plainText("This shell doesn't report its commands to Shelly; Shelly hooks into zsh, bash and fish.", colorDepth, 'muted');
      }
      const thread = this.next.newThread ? undefined : this.thread;
      const context = await this.contextFor(thread?.id ?? '');
      const next = this.nextAgentId();
      const target = thread ? `${this.nameOf(thread.agentId)} · “${oneLine(thread.title) || 'this thread'}”` : `${next ? this.nameOf(next) : 'the agent'} · new thread`;
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
      return plainText(lines.join('\n'), colorDepth);
    });
  }

  private showHelp(open: OpenInput): Promise<void> {
    const { colorDepth } = this.host;
    return this.printBelow(open, '/help', () => {
      const key = (name: string, text: string): Line => [seg(`  ${name.padEnd(10)}`, 'accent', { bold: true }), seg(text)];
      const lines: Line[] = [
        key('::', 'ask your agent, or hand it a task (in a thread you can come back to)'),
        key('__', 'describe a command; it lands on your prompt, ready to edit or run'),
        key('ctrl+]', 'rewrite the command you are typing'),
        [],
        ...BUILTIN_COMMANDS.map((command) => key(`/${command.name}`, command.description)),
        [],
        // The same keys, in the same words, as the agent's own status line.
        [seg('  While the agent works: ', 'muted'), seg('esc', 'accent'), seg(' background · ', 'muted'), seg('^c', 'accent'), seg(' stop', 'muted')],
        [seg('  When it asks:          ', 'muted'), seg('←→', 'accent'), seg(' select · ', 'muted'), seg('enter', 'accent'), seg(' confirm · ', 'muted'),
          seg('y/n', 'accent'), seg(' · ', 'muted'), seg('esc', 'accent'), seg(' reject', 'muted')],
      ];
      return linesText(lines, colorDepth);
    });
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
        return `${this.thread ? this.nameOf(this.thread.agentId) : 'The agent'} is still working on the last request · empty the line, then ${SEE}`;
      case 'DaemonDisconnected':
        return "Lost the connection to Shelly's background service · try again";
      case 'AgentUnavailable': {
        const message = messageOf(error) || "The agent can't be used right now.";
        const unavailable = (error as { agentId?: string }).agentId;
        const another = this.agents.some((agent) => agent.available && agent.id !== unavailable);
        return another ? `${message} · /agent to pick another` : message;
      }
      default:
        return messageOf(error) || 'Something went wrong.';
    }
  }

  private async refreshAgents(client: DaemonClient): Promise<void> {
    this.agents = await client.listAgents();
    this.agentsAt = Date.now();
  }

  /** Once connected: learn the agents now, so the first prompt's view names the right one. */
  async connected(client: DaemonClient): Promise<void> {
    if (this.agents.length === 0) {
      await this.refreshAgents(client);
    }
  }

  /** Detach on exit, so another terminal can take the thread without asking. */
  goodbye(client: DaemonClient): Promise<unknown> {
    return this.thread ? client.detachThread(this.thread.id) : Promise.resolve();
  }

  /** Shelly is exiting: nothing draws to the terminal after this, and no flow takes it again. */
  dispose(): void {
    this.inputGeneration++;
    this.view?.destroy();
    this.view = undefined;
  }

  /** A turn's view is on screen. */
  isDrawing(): boolean {
    return this.view !== undefined;
  }

  /** The terminal was resized (and has settled) while Shelly draws below the prompt. */
  relayout(): void {
    void this.view?.relayout();
  }
}

/** Why an agent can't be used, in two or three words for the hint. */
const unavailableLabel = (agent: AgentInfo): string => {
  const reason = agent.unavailableReason ?? '';
  return /\bisn't installed|\bnot installed/i.test(reason)
    ? 'not installed'
    : /\bsign(?:ed)? in\b/i.test(reason) ? 'not signed in' : 'unavailable';
};

/** A mode's name, when it is not the agent's first (usual) one. */
const labelOf = (modes: ModeState | undefined): string | undefined => {
  if (!modes || modes.availableModes[0]?.id === modes.currentModeId) {
    return undefined;
  }
  return modes.availableModes.find((mode) => mode.id === modes.currentModeId)?.name ?? modes.currentModeId;
};

const fromSummary = (summary: ThreadSummary): CurrentThread => ({
  id: summary.id,
  title: summary.title,
  agentId: summary.agentId,
  location: summary.location,
  status: summary.status,
});
