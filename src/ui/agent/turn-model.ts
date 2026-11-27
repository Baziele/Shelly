import type {
  PermissionOption,
  PlanEntry,
  ThreadEvent,
  ThreadEventOf,
  ToolCall,
} from '../../protocol/schema.js';

/*
 * What a turn has shown so far, as an ordered list of blocks. Blocks become
 * final in any order (a tool can finish while text before it still streams),
 * but they reach scrollback in order: the stable prefix is the run of final
 * blocks at the front that has not been committed yet.
 */

export interface MessageBlock {
  readonly kind: 'message';
  readonly key: string;
  readonly messageId: string;
  text: string;
  final: boolean;
  version: number;
}

export interface ToolBlock {
  readonly kind: 'tool';
  readonly key: string;
  tool: ToolCall;
  final: boolean;
  /** The turn ended before the tool did. */
  stopped: boolean;
  version: number;
}

export type LineBlockContent =
  | { readonly type: 'notice'; readonly level: 'info' | 'warning' | 'error'; readonly text: string }
  | { readonly type: 'mode'; readonly name: string }
  | { readonly type: 'permission'; readonly title: string; readonly outcome: PermissionOption['kind'] | null }
  | { readonly type: 'plan'; readonly entries: readonly PlanEntry[] }
  | { readonly type: 'summary'; readonly ended: ThreadEventOf<'turn.ended'>; readonly toolCount: number };

export interface LineBlock {
  readonly kind: 'line';
  readonly key: string;
  readonly content: LineBlockContent;
  readonly final: true;
  readonly version: 0;
}

export type Block = MessageBlock | ToolBlock | LineBlock;

export type PermissionRequest = ThreadEventOf<'permission.requested'>;

export type Phase =
  | { readonly type: 'starting' }
  | { readonly type: 'thinking' }
  | { readonly type: 'writing' }
  | { readonly type: 'running'; readonly tool: ToolCall }
  | { readonly type: 'waiting' }
  | { readonly type: 'stopping' }
  | { readonly type: 'ended' };

type Activity = { type: 'none' } | { type: 'thought' } | { type: 'text' } | { type: 'tool'; id: string };

export class TurnModel {
  readonly blocks: Block[] = [];
  /** Blocks before this index are in scrollback. */
  committed = 0;
  /** The latest thought, shown live and never committed. */
  thought: string | undefined;
  /** The current plan, shown live; it is committed when the turn ends. */
  plan: readonly PlanEntry[] | undefined;
  /** Permission requests waiting for an answer, oldest first; the first is shown. */
  readonly permissions: PermissionRequest[] = [];
  startedAt: number | undefined;
  ended: ThreadEventOf<'turn.ended'> | undefined;
  stopping = false;

  private nextKey = 0;
  private thoughtMessageId: string | undefined;
  private activity: Activity = { type: 'none' };
  private readonly toolIds = new Set<string>();
  /** Requests this client answered, so the daemon's echo of the answer adds nothing. */
  private readonly answered = new Set<string>();

  get toolCount(): number {
    return this.toolIds.size;
  }

  /** Index one past the last block that can be committed now. */
  get stablePrefixEnd(): number {
    let end = this.committed;
    while (end < this.blocks.length && this.blocks[end]!.final) {
      end++;
    }
    return end;
  }

  get phase(): Phase {
    if (this.ended) {
      return { type: 'ended' };
    }
    if (this.stopping) {
      return { type: 'stopping' };
    }
    if (this.permissions.length > 0) {
      return { type: 'waiting' };
    }
    switch (this.activity.type) {
      case 'none':
        return this.startedAt === undefined ? { type: 'starting' } : { type: 'thinking' };
      case 'thought':
        return { type: 'thinking' };
      case 'text':
        return { type: 'writing' };
      case 'tool': {
        const block = this.findTool(this.activity.id);
        return block && !block.final ? { type: 'running', tool: block.tool } : { type: 'thinking' };
      }
    }
  }

  apply(event: ThreadEvent): void {
    if (this.ended && event.type !== 'mode.changed' && event.type !== 'notice') {
      return;
    }
    switch (event.type) {
      case 'turn.started':
        this.startedAt = event.at;
        return;
      case 'message.chunk':
        this.applyChunk(event);
        return;
      case 'tool.updated':
        this.applyTool(event.tool);
        return;
      case 'plan.updated':
        this.plan = event.entries;
        return;
      case 'permission.requested':
        if (!this.permissions.some((request) => request.requestId === event.requestId) && !this.answered.has(event.requestId)) {
          this.permissions.push(event);
        }
        return;
      case 'permission.resolved':
        this.resolvePermission(event.requestId, event.optionId);
        return;
      case 'mode.changed': {
        const mode = event.availableModes.find((candidate) => candidate.id === event.currentModeId);
        this.appendLine({ type: 'mode', name: mode?.name ?? event.currentModeId });
        return;
      }
      case 'notice':
        this.appendLine({ type: 'notice', level: event.level, text: event.text });
        return;
      case 'turn.ended':
        this.end(event);
        return;
    }
  }

  /** The user answered the first prompt here; it collapses at once, before the daemon confirms. */
  answer(requestId: string, optionId: string | null): void {
    this.resolvePermission(requestId, optionId);
    this.answered.add(requestId);
  }

  /** Blocks `[committed, end)` have reached scrollback. */
  markCommitted(end: number): void {
    this.committed = Math.max(this.committed, Math.min(end, this.blocks.length));
  }

  private applyChunk(event: ThreadEventOf<'message.chunk'>): void {
    if (event.kind === 'thought') {
      this.thought = event.messageId === this.thoughtMessageId ? (this.thought ?? '') + event.text : event.text;
      this.thoughtMessageId = event.messageId;
      this.activity = { type: 'thought' };
      return;
    }

    if (event.text === '') {
      return;
    }
    this.thought = undefined;
    this.activity = { type: 'text' };
    const last = this.blocks.at(-1);
    if (last?.kind === 'message' && last.messageId === event.messageId && !last.final && this.blocks.length > this.committed) {
      last.text += event.text;
      last.version++;
      return;
    }
    this.finalizeMessages();
    this.blocks.push({ kind: 'message', key: this.key(), messageId: event.messageId, text: event.text, final: false, version: 0 });
  }

  private applyTool(tool: ToolCall): void {
    this.thought = undefined;
    this.activity = { type: 'tool', id: tool.id };
    const existing = this.findTool(tool.id);
    if (existing) {
      if (this.blocks.indexOf(existing) < this.committed) {
        return;
      }
      existing.tool = tool;
      existing.final = isToolDone(tool);
      existing.version++;
      return;
    }
    this.toolIds.add(tool.id);
    this.finalizeMessages();
    this.blocks.push({ kind: 'tool', key: this.key(), tool, final: isToolDone(tool), stopped: false, version: 0 });
  }

  private resolvePermission(requestId: string, optionId: string | null): void {
    if (this.answered.has(requestId)) {
      return;
    }
    const index = this.permissions.findIndex((request) => request.requestId === requestId);
    if (index < 0) {
      return;
    }
    const [request] = this.permissions.splice(index, 1);
    const option = request!.options.find((candidate) => candidate.optionId === optionId);
    const line: LineBlock = {
      kind: 'line',
      key: this.key(),
      content: { type: 'permission', title: request!.title, outcome: option?.kind ?? null },
      final: true,
      version: 0,
    };

    // The outcome reads best just above the tool it was about, while that tool is still live.
    const tool = request!.toolCallId ? this.findTool(request!.toolCallId) : undefined;
    // A finished tool may be on its way to scrollback, so the line goes after it then.
    const toolIndex = tool && !tool.final ? this.blocks.indexOf(tool) : -1;
    if (toolIndex >= this.committed) {
      this.blocks.splice(toolIndex, 0, line);
    } else {
      this.finalizeMessages();
      this.blocks.push(line);
    }
  }

  private appendLine(content: LineBlockContent): void {
    this.finalizeMessages();
    this.blocks.push({ kind: 'line', key: this.key(), content, final: true, version: 0 });
  }

  private end(event: ThreadEventOf<'turn.ended'>): void {
    this.finalizeMessages();
    for (const block of this.blocks.slice(this.committed)) {
      if (block.kind === 'tool' && !block.final) {
        block.final = true;
        block.stopped = true;
        block.version++;
      }
    }
    for (const request of [...this.permissions]) {
      this.resolvePermission(request.requestId, null);
    }
    if (this.plan && this.plan.length > 0) {
      this.appendLine({ type: 'plan', entries: this.plan });
    }
    this.appendLine({ type: 'summary', ended: event, toolCount: this.toolCount });
    this.ended = event;
    this.thought = undefined;
    this.plan = undefined;
  }

  private finalizeMessages(): void {
    for (let index = this.blocks.length - 1; index >= this.committed; index--) {
      const block = this.blocks[index]!;
      if (block.kind === 'message' && !block.final) {
        block.final = true;
        block.version++;
      }
    }
  }

  private findTool(id: string): ToolBlock | undefined {
    for (let index = this.blocks.length - 1; index >= 0; index--) {
      const block = this.blocks[index]!;
      if (block.kind === 'tool' && block.tool.id === id) {
        return block;
      }
    }
    return undefined;
  }

  private key(): string {
    return `b${this.nextKey++}`;
  }
}

const isToolDone = (tool: ToolCall): boolean => tool.status === 'completed' || tool.status === 'failed';

/** Whether a gap row separates `block` from the one before it: prose and tool rows are set apart. */
export const hasGapBefore = (previous: Block | undefined, block: Block): boolean => {
  if (!previous) {
    return false;
  }
  if (block.kind === 'line' && (block.content.type === 'summary' || block.content.type === 'plan')) {
    return true;
  }
  return previous.kind === 'message' || block.kind === 'message';
};
