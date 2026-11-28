import { scenarioOptions } from '../../e2e/stack.js';
import type { ScenarioDriver } from '../scenario.js';

/** Fast mode: a command on the line, an answer, an error, and Ctrl+] on a half-typed command. */
export const options = scenarioOptions({ shell: '/bin/zsh', cols: 100, rows: 20 });

export default async (driver: ScenarioDriver): Promise<void> => {
  await driver.type('__');
  await driver.waitForText('Describe a command');
  await driver.screenshot('fast-input');
  await driver.type('find big files');
  await driver.press('enter');
  await driver.waitForText(/^\$ echo pid=\d+ turn=1$/m, { timeoutMs: 20_000 });
  await driver.screenshot('command-on-the-line');
  await driver.press('ctrl-u');

  await driver.type('__reply: # Use `du -sh *` to see what is big.');
  await driver.press('enter');
  await driver.waitForText('to see what is big', { timeoutMs: 20_000 });
  await driver.waitForStable({ quietMs: 300 });
  await driver.screenshot('answer');

  await driver.type('__auth');
  await driver.press('enter');
  await driver.waitForText('✗', { timeoutMs: 20_000 });
  await driver.screenshot('error-keeps-input');
  await driver.press('esc');
  await driver.waitFor((lines) => !lines.some((line) => line.includes('__ auth')), 'the input closed');

  await driver.type('git psuh origin main');
  await driver.press('ctrl-]');
  await driver.waitForText('rewriting: git psuh origin main');
  await driver.type('fix the typo');
  await driver.screenshot('rewrite-input');
  await driver.press('enter');
  await driver.waitForText(/^\$ echo pid=\d+ turn=\d$/m, { timeoutMs: 20_000 });
  await driver.screenshot('rewritten-line');
};
