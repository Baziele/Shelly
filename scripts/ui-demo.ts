/*
 * Plays a synthetic ThreadEvent sequence through Shelly's real UI
 * components, in the terminal you run it in, with realistic timing.
 *
 *   pnpm demo                    list the sequences
 *   pnpm demo tool-heavy         play one
 *   pnpm demo --all              play them all, one after another
 *   pnpm demo long-answer --speed 2
 *
 * Agent sequences accept your keys as a real turn would: answer permission
 * prompts, press esc to background, ctrl-c to stop. Resize the window
 * mid-turn to see the live region reflow. NO_COLOR=1 shows the no-colour
 * rendering; COLORTERM=truecolor or TERM=linux pick other depths.
 */
import { setTimeout as sleep } from 'node:timers/promises';
import { BUILTIN_COMMANDS, CommandRegistry } from '../src/commands/slash-commands.js';
import { detectColorDepth } from '../src/render/sgr.js';
import { ansi } from '../src/terminal/ansi.js';
import { HostTerminal } from '../src/terminal/host-terminal.js';
import { AgentView } from '../src/ui/agent/agent-view.js';
import { renderHistory } from '../src/ui/agent/history.js';
import { renderAnswer } from '../src/ui/agent/static-render.js';
import { InlineOverlay } from '../src/ui/inline-overlay.js';
import { fixtureEvents, fixtureNames, loadFixture, timeline, type Fixture } from '../test/fixtures/thread-events/load.js';

const args = process.argv.slice(2);
const speedFlag = args.indexOf('--speed');
const speed = speedFlag >= 0 ? Number(args[speedFlag + 1]) || 1 : 1;
const names = args.includes('--all') ? fixtureNames() : args.filter((arg, index) => !arg.startsWith('--') && index !== speedFlag + 1);

if (names.length === 0) {
  console.log('Sequences (pnpm demo <name> [--speed N], or --all):\n');
  for (const name of fixtureNames()) {
    console.log(`  ${name.padEnd(20)} ${loadFixture(name).description}`);
  }
  process.exit(0);
}

const host = new HostTerminal();
if (!host.isInteractive) {
  console.error('ui-demo needs a terminal.');
  process.exit(1);
}
const colorDepth = detectColorDepth();
/** The fake shell prompt the demo pretends to sit at; the fixture's directory under the real home. */
const promptFor = (fixture: Fixture): string => `\u001b[1;34m~/${fixture.cwd.split('/').at(-1)}\u001b[0m $ `;
let inputListener: (data: string) => void = () => {};
host.start((data) => {
  if (data === '\u0004') {
    // ctrl-d leaves the demo.
    host.write(ansi.showCursor + '\r\n');
    host.stop();
    process.exit(0);
  }
  inputListener(data);
});

const playAgent = async (fixture: Fixture): Promise<void> => {
  host.write(`${promptFor(fixture)}\u001b[1;35m::\u001b[0m ${fixture.prompt}\r\n`);
  const view = new AgentView(host, colorDepth, { agentName: fixture.agent, cwd: fixture.cwd, home: fixture.home });
  view.onAction((action) => {
    if (action.type === 'cancel') {
      // A real daemon would end the turn as cancelled shortly after.
      setTimeout(() => view.apply({ seq: 9_999, type: 'turn.ended', turnId: 't1', stopReason: 'cancelled', error: null, durationMs: 0 }), 600);
    }
  });
  inputListener = (data) => {
    view.handleInput(data);
  };
  let resizeTimer: NodeJS.Timeout | undefined;
  const stopResizing = host.onResize(() => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => void view.relayout(), 50);
  });
  view.start(await host.queryCursorPosition());

  const start = performance.now();
  for (const action of timeline(fixture, { speed })) {
    const wait = action.at - (performance.now() - start);
    if (wait > 1) {
      await sleep(wait);
    }
    if (action.type === 'event') {
      view.apply(action.event);
    } else if (action.type === 'keys') {
      // Keys for a permission prompt wait until it is drawn and armed, however long that takes.
      for (let waited = 0; view.promptState === 'arming' && waited < 10_000; waited += 10) {
        await sleep(10);
      }
      view.handleInput(action.keys);
    }
  }
  await view.finish();
  stopResizing();
  view.destroy();
  inputListener = () => {};
};

const playHistory = async (fixture: Fixture): Promise<void> => {
  host.write(`${promptFor(fixture)}\u001b[1;35m::\u001b[0m /threads\r\n`);
  const text = await renderHistory(fixtureEvents(fixture), {
    agentName: fixture.agent,
    title: fixture.title ?? fixture.prompt,
    updatedAt: Date.now() - (fixture.updatedAgoMs ?? 0),
    cwd: fixture.cwd,
    home: fixture.home,
    width: host.size.cols,
    colorDepth,
  });
  host.write(text);
};

const playFast = async (fixture: Fixture): Promise<void> => {
  const prompt = promptFor(fixture);
  host.write(prompt + (fixture.buffer ?? ''));
  const cursor = await host.queryCursorPosition();
  const origin = { row: cursor.row, col: cursor.col - (fixture.buffer?.length ?? 0) };
  let submitted = false;
  let cancelled = false;
  const overlay = new InlineOverlay(host, new CommandRegistry(BUILTIN_COMMANDS), colorDepth, {
    onSubmit: () => {
      submitted = true;
    },
    onCancel: () => {
      cancelled = true;
    },
  });
  inputListener = (data) => overlay.feed(data);
  if (fixture.buffer) {
    // A captured command line: Shelly clears it and offers to rewrite it.
    host.write(ansi.cursorTo(origin.row, origin.col) + ansi.eraseToLineEnd);
  }
  overlay.open(origin, '__', '', fixture.buffer ? { rewriting: fixture.buffer } : {});

  // Type the request like a person would, then press enter.
  for (const char of fixture.prompt) {
    await sleep(35 / speed);
    overlay.feed(char);
  }
  await sleep(250 / speed);
  overlay.feed('\r');
  await sleep(20);
  if (!submitted) {
    overlay.close();
    overlay.destroy();
    return;
  }
  overlay.setBusy(true);

  let reply = '';
  const start = performance.now();
  for (const action of timeline(fixture, { speed })) {
    const wait = action.at - (performance.now() - start);
    if (wait > 1) {
      await sleep(wait);
    }
    if (cancelled) {
      break;
    }
    if (action.type === 'fast' && action.event.type === 'delta') {
      reply += action.event.text;
      overlay.setPreview(reply);
    } else if (action.type === 'fast' && action.event.type === 'done') {
      overlay.close();
      if (action.event.kind === 'command') {
        // The command lands on the shell's input line, as if typed.
        host.write(action.event.text);
        await sleep(1200 / speed);
        host.write('\r\n');
      } else {
        host.write(`\u001b[1;36m__\u001b[0m ${fixture.prompt}\r\n`);
        host.write(await renderAnswer(action.event.text, host.size.cols, colorDepth));
      }
    } else if (action.type === 'fast-error') {
      overlay.setError(action.message);
      await sleep(2500 / speed);
      overlay.close();
      host.write('\r\n');
    }
  }
  if (cancelled) {
    overlay.close();
    host.write('\r\n');
  }
  overlay.destroy();
  inputListener = () => {};
};

for (const [index, name] of names.entries()) {
  const fixture = loadFixture(name);
  if (index > 0) {
    await sleep(900);
  }
  if (fixture.kind === 'agent') {
    await playAgent(fixture);
  } else if (fixture.kind === 'history') {
    await playHistory(fixture);
  } else {
    await playFast(fixture);
  }
}
host.write('\u001b[2m(demo over · press any key)\u001b[0m');
await new Promise<void>((resolve) => {
  inputListener = () => resolve();
  setTimeout(resolve, Number(process.env.SHELLY_DEMO_LINGER_MS ?? 60_000)).unref();
});
host.write('\r\n' + ansi.showCursor);
host.stop();
process.exit(0);
