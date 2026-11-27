import { loadFixture } from '../fixtures/thread-events/load.js';
import { playFixture } from '../support/play.js';
import { EmulatedTerminal } from '../support/emulated-terminal.js';
import { useModernWidths } from '../tools/unicode.js';
import { writeScreenshot } from '../tools/screen.js';
import { AgentView } from '../../src/ui/agent/agent-view.js';
import type { ColorDepth } from '../../src/render/sgr.js';

const OUT = new URL('../../.scenario-out/review/gallery', import.meta.url).pathname;
const [names, sizes, depths] = [process.argv[2]!.split(','), process.argv[3]!.split(','), process.argv[4]!.split(',') as ColorDepth[]];
for (const name of names) for (const size of sizes) for (const depth of depths) {
  const [cols, rows] = size.split('x').map(Number) as [number, number];
  const fixture = loadFixture(name);
  const term = new EmulatedTerminal(cols, rows);
  useModernWidths(term.terminal);
  term.write(`\u001b[1;34m~/acme\u001b[0m $ \u001b[1;35m::\u001b[0m ${fixture.prompt}\r\n`);
  const view = new AgentView(term, depth, { agentName: fixture.agent, cwd: fixture.cwd, home: fixture.home });
  view.start(await term.cursor());
  await playFixture(view, fixture, 20);
  await view.finish();
  view.destroy();
  const r = await writeScreenshot(term.terminal, `${OUT}/${name}-${size}-${depth}`, { scrollback: true } as never);
  console.log(r.png ?? r.pngError);
}
