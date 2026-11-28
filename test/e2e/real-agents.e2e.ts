import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { findExecutable } from '../../src/daemon/agents/definitions.js';
import { lastPromptRow } from '../tools/scenario.js';
import { startStack, type Stack } from './stack.js';

/*
 * The whole stack against the real agents, gated: SHELLY_REAL_AGENTS=1.
 * It costs money, so it makes a handful of tiny requests: one agent-mode
 * turn on Claude Code (haiku, set through config.json), two fast requests
 * (the second on a warm worker, timed), and, if OpenCode is installed, one
 * turn on a free model.
 *
 * The agents need the user's own logins, so HOME is the real one. Shelly's
 * state lives in a throwaway SHELLY_HOME, zsh reads a throwaway ZDOTDIR (a
 * plain `$ ` prompt), and the shell starts in a throwaway folder, so
 * nothing is written into the user's projects or dotfiles.
 *
 *   SHELLY_REAL_AGENTS=1 node --experimental-ffi --no-warnings --import tsx --test test/e2e/real-agents.e2e.ts
 */

const enabled = process.env.SHELLY_REAL_AGENTS === '1';
const TURN_MS = 120_000;

const temps: string[] = [];
const temp = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
};
after(() => temps.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const promptRow = (lines: string[]): string => lines[lastPromptRow(lines)]?.trimEnd() ?? '';

describe('Shelly with the real agents', { skip: !enabled && 'set SHELLY_REAL_AGENTS=1 to run', timeout: 600_000 }, () => {
  let stack: Stack | undefined;
  after(async () => stack?.stop());

  it('answers in agent mode on Claude Code (haiku), writes a command in fast mode, and runs OpenCode', async () => {
    const zdotdir = temp('shelly-zdot-');
    writeFileSync(join(zdotdir, '.zshrc'), "PS1='$ '\n");
    const hasOpenCode = findExecutable('opencode') !== null;
    stack = await startStack({
      realAgents: true,
      shell: '/bin/zsh',
      cols: 110,
      rows: 30,
      home: homedir(),
      cwd: temp('shelly-work-'),
      // The agents find their logins with these (Claude Code's is in the keychain, under the user).
      env: {
        ZDOTDIR: zdotdir,
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        ...Object.fromEntries(['USER', 'LOGNAME', 'TMPDIR'].flatMap((name) => (process.env[name] ? [[name, process.env[name]!]] : []))),
      },
      config: {
        defaultAgent: 'claude',
        agents: { claude: { model: 'haiku' }, opencode: { model: 'opencode-go/hy4-flash-free' } },
      },
    });
    const driver = stack.driver;

    // Agent mode on Claude Code.
    await driver.type('::');
    await driver.waitForText(/Claude Code · new thread/, { timeoutMs: 30_000 });
    await driver.type('Reply with exactly the word PONG and nothing else.\r');
    let lines = await driver.waitFor(
      (rows) => rows.some((row) => /^[✓✗◼] /.test(row)) && promptRow(rows) === '$',
      'the Claude Code turn',
      { timeoutMs: TURN_MS },
    );
    assert.ok(lines.some((row) => row.trim() === 'PONG'), `the answer:\n${lines.join('\n')}`);
    assert.ok(lines.some((row) => /^✓ /.test(row)), 'ended normally');

    // Fast mode on the real claude: once cold, once warm (timed).
    const fast = async (request: string): Promise<{ ms: number; line: string }> => {
      await driver.type('__');
      await driver.waitForText('Describe a command', { timeoutMs: 10_000 });
      await driver.type(request);
      const started = performance.now();
      await driver.press('enter');
      lines = await driver.waitFor((rows) => !rows.some((row) => row.includes('__ ')) && promptRow(rows) !== '$', 'the command on the line', { timeoutMs: TURN_MS });
      return { ms: Math.round(performance.now() - started), line: promptRow(lines) };
    };
    const cold = await fast('print the current date');
    assert.match(cold.line, /^\$ .*date/, cold.line);
    await driver.press('ctrl-u');
    const warm = await fast('show the current directory');
    assert.match(warm.line, /^\$ .*pwd/, warm.line);
    await driver.press('ctrl-u');
    console.log(`fast mode: cold ${cold.ms} ms, warm ${warm.ms} ms (Enter to command on the line)`);

    if (hasOpenCode) {
      await driver.type('::/agent\r');
      await driver.waitForText('Pick the agent', { timeoutMs: 10_000 });
      await driver.type('opencode\r');
      await driver.waitForText(/OpenCode · new thread/, { timeoutMs: 10_000 });
      await driver.type('Reply with exactly the word PONG and nothing else.\r');
      lines = await driver.waitFor(
        (rows) => {
          const echo = rows.findLastIndex((row) => row.startsWith('$ :: Reply with exactly'));
          return echo >= 0 && rows.slice(echo).some((row) => /^[✓✗◼] /.test(row)) && promptRow(rows) === '$';
        },
        'the OpenCode turn',
        { timeoutMs: TURN_MS },
      );
      const turn = lines.slice(lines.findLastIndex((row) => row.startsWith('$ :: Reply with exactly')));
      assert.ok(turn.some((row) => row.includes('PONG')), `the answer:\n${turn.join('\n')}`);
    }
  });
});
