import { scenarioOptions } from '../../e2e/stack.js';
import { lastPromptRow, type ScenarioDriver } from '../scenario.js';

/** Threads and slash commands: the popup, /threads with history, /mode, /agent, /context, /help. */
export const options = scenarioOptions({ shell: '/bin/zsh', cols: 110, rows: 30 });

/** Wait for Shelly's input to close (a key sent before Esc lands would read as Alt+key). */
const closed = (driver: ScenarioDriver) =>
  driver.waitFor((lines) => /^\$\s*$/.test(lines[lastPromptRow(lines)] ?? ''), 'the prompt');

const turn = async (driver: ScenarioDriver, text: string): Promise<void> => {
  await driver.type(`::${text}\r`);
  await driver.waitFor((lines) => lines.some((line) => /^✓ /.test(line)) && lines.at(-1) !== undefined, 'the answer', { timeoutMs: 20_000 });
  await driver.waitForStable({ quietMs: 300 });
};

export default async (driver: ScenarioDriver): Promise<void> => {
  await turn(driver, 'please name yourself');
  await driver.type('clear\r');
  await driver.waitForStable({ quietMs: 200 });
  await driver.type('::/');
  await driver.waitForText('› /new');
  await driver.screenshot('slash-popup');
  await driver.type('new\r');
  await driver.waitForText('fake · new thread');
  await driver.screenshot('after-new');
  await driver.press('esc');
  await closed(driver);
  await turn(driver, 'show me markdown');
  await driver.type('clear\r');
  await driver.waitForStable({ quietMs: 200 });

  await driver.type('::/threads\r');
  await driver.waitForText('Pick a thread');
  await driver.screenshot('threads-picker');
  await driver.press('down');
  await driver.press('enter');
  await driver.waitForText('“Agent picked title”', { timeoutMs: 20_000 });
  await driver.waitForStable({ quietMs: 300 });
  await driver.screenshot('switched-with-history');

  await driver.type('::/mode\r');
  await driver.waitForText('Pick a mode', { timeoutMs: 20_000 });
  await driver.screenshot('mode-picker');
  await driver.type('plan\r');
  await driver.waitForText('Plan ·');
  await driver.screenshot('mode-in-hint');
  await driver.type('/agent\r');
  await driver.waitForText('Pick the agent');
  await driver.screenshot('agent-picker');
  await driver.press('esc');
  await driver.waitFor((lines) => !lines.some((line) => line.includes('Pick the agent')), 'the picker closed');
  await driver.press('esc');
  await closed(driver);

  await driver.type('clear\r');
  await driver.waitForStable({ quietMs: 200 });
  await driver.type('echo something\r');
  await driver.waitForStable({ quietMs: 200 });
  await driver.type('::/context\r');
  await driver.waitForText('With your next message');
  await driver.waitForStable({ quietMs: 300 });
  await driver.screenshot('context');
  await driver.type('clear\r');
  await driver.waitForStable({ quietMs: 200 });
  await driver.type('::/help\r');
  await driver.waitForText('While the agent works');
  await driver.waitForStable({ quietMs: 300 });
  await driver.screenshot('help');
};
