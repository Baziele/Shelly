import type { ScenarioDriver } from '../scenario.js';

/** Opens Shelly's input with `::`, runs /context and checks the answer. */
export default async (driver: ScenarioDriver): Promise<void> => {
  await driver.type('echo hello\r');
  await driver.waitForText(/^hello$/m);
  await driver.screenshot('shell-prompt');

  await driver.type('::');
  await driver.waitForText(':: Ask Shelly');
  await driver.screenshot('input-open');

  await driver.type('/context');
  await driver.waitForText('› /context');
  await driver.screenshot('command-typed');

  await driver.press('enter');
  await driver.waitForText(/Working directory: [\s\S]*\n\$\s*$/);
  await driver.screenshot('context-shown');
};
