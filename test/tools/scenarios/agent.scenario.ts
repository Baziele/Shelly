import { setTimeout as sleep } from 'node:timers/promises';
import { scenarioOptions } from '../../e2e/stack.js';
import type { ScenarioDriver } from '../scenario.js';

/** Agent mode: the input, a markdown answer, tools, a permission, Esc to background and watching it again. */
export const options = scenarioOptions({ shell: '/bin/zsh', cols: 100, rows: 30 });

const prompt = (lines: string[]): boolean => lines.at(-1) !== undefined && lines.some((line) => line === '$');

export default async (driver: ScenarioDriver): Promise<void> => {
  await driver.type('echo hello from the shell\r');
  await driver.waitForText(/^hello from the shell$/m);
  await driver.type('::');
  await driver.waitForText(/Fake Agent · new thread/, { timeoutMs: 15_000 });
  await driver.screenshot('input-with-hint');

  await driver.type('show me markdown');
  await driver.press('enter');
  await driver.screenshot('first-feedback');
  await driver.waitForText(/✓ \d/, { timeoutMs: 20_000 });
  await driver.waitForStable({ quietMs: 300 });
  await driver.screenshot('markdown-answer');

  await driver.type('clear\r');
  await driver.waitFor(prompt, 'a clear screen');
  await driver.type('::run the tools\r');
  await driver.waitForText(/Running|Reading|Searching/, { timeoutMs: 20_000 });
  await driver.screenshot('tools-running');
  await driver.waitForText(/✓ .* tools/, { timeoutMs: 20_000 });
  await driver.waitForStable({ quietMs: 300 });
  await driver.screenshot('tools-done');

  await driver.type('clear\r');
  await driver.waitFor(prompt, 'a clear screen');
  await driver.type('::permission please\r');
  await driver.waitForText('wants to: Edit .env.example', { timeoutMs: 20_000 });
  // The spinner never lets the screen settle, and a prompt ignores keys for its first 300 ms.
  await sleep(500);
  await driver.screenshot('permission-asked');
  await driver.type('y');
  await driver.waitForText(/✓ \d/, { timeoutMs: 20_000 });
  await driver.waitForStable({ quietMs: 300 });
  await driver.screenshot('permission-answered');

  await driver.type('clear\r');
  await driver.waitFor(prompt, 'a clear screen');
  await driver.type('::slow build\r');
  await driver.waitForText('Running make', { timeoutMs: 20_000 });
  await driver.screenshot('slow-turn-running');
  await driver.press('esc');
  await driver.waitForText('still working');
  await driver.type('ls -d /tmp\r');
  await driver.waitForStable({ quietMs: 300 });
  await driver.screenshot('backgrounded-shell-free');
  await driver.type('::');
  await driver.waitForText(/enter to (watch|see)/);
  await driver.screenshot('hint-working');
  await driver.press('enter');
  await driver.waitForText('The build passed', { timeoutMs: 20_000 });
  await driver.waitForStable({ quietMs: 300 });
  await driver.screenshot('watched-to-the-end');
  await sleep(50);
};
