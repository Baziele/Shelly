import { EmulatedTerminal } from '../support/emulated-terminal.js';
import { useModernWidths } from '../tools/unicode.js';
import { writeScreenshot } from '../tools/screen.js';
import type { ThreadEvent } from '../../src/protocol/schema.js';
import type { ColorDepth } from '../../src/render/sgr.js';
import { AgentView, type AgentAction } from '../../src/ui/agent/agent-view.js';

export const OUT = process.env.REVIEW_OUT ?? new URL('../../.scenario-out/review', import.meta.url).pathname;

let seq = 1;
export const ev = (partial: Record<string, unknown>): ThreadEvent => ({ seq: ++seq, turnId: 't1', ...partial }) as ThreadEvent;
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const setup = async (cols: number, rows: number, depth: ColorDepth = 'ansi256', modern = true) => {
  const term = new EmulatedTerminal(cols, rows);
  if (modern) useModernWidths(term.terminal);
  term.write(`~/acme $ :: question\r\n`);
  const view = new AgentView(term, depth, { agentName: 'claude', cwd: '/home/dev/acme', home: '/home/dev' });
  const actions: AgentAction[] = [];
  view.onAction((a) => actions.push(a));
  view.start(await term.cursor());
  view.apply(ev({ type: 'turn.started', text: 'q', at: Date.now() }));
  return { term, view, actions };
};

export const shot = async (term: EmulatedTerminal, name: string) => {
  await term.flush();
  const result = await writeScreenshot(term.terminal, `${OUT}/${name}`, { scrollback: true } as never);
  return result;
};
