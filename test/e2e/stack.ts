import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readLock } from '../../src/daemon/lock.js';
import { shellyPaths } from '../../src/protocol/paths.js';
import { type DriverOptions, ScenarioDriver, stopDaemonIn } from '../tools/scenario.js';

/*
 * The whole of Shelly for end-to-end tests: the client in a real pty, the
 * daemon it starts on demand (with the real agent and fast-mode layers),
 * the fake ACP agent registered in config.json as the default agent, and
 * the fake `claude` on PATH for fast mode. Everything lives in a throwaway
 * SHELLY_HOME (and HOME), and `stop()` leaves no process behind: closing the
 * driver stops the daemon (see stopDaemonIn).
 */

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const TSX = import.meta.resolve('tsx');
export const FAKE_AGENT = join(ROOT, 'test', 'fixtures', 'fake-agent', 'fake-acp-agent.ts');
export const FAKE_CLAUDE = join(ROOT, 'test', 'fixtures', 'fake-claude.mjs');
export const E2E_SCENARIO = join(ROOT, 'test', 'e2e', 'fixtures', 'agent.scenario.ts');

/** zsh and bash, plus SHELLY_E2E_SHELLS (colon-separated paths; CI adds fish on Linux). */
export const E2E_SHELLS = ['/bin/zsh', '/bin/bash', ...(process.env.SHELLY_E2E_SHELLS?.split(':').filter(Boolean) ?? [])]
  .filter((shell, index, all) => existsSync(shell) && all.indexOf(shell) === index);

export interface StackOptions extends DriverOptions {
  /** The fake agent's scenario (a bundled name or a path). Default: the e2e scenario. */
  readonly scenario?: string;
  /** Extra config.json content, merged over the fake agent's. */
  readonly config?: Record<string, unknown>;
  /** Env for the fake claude (FAKE_CLAUDE_LOG, …). */
  readonly fakeClaudeEnv?: Record<string, string>;
  /** Use the real agents: no config, no fake claude, the caller's PATH and HOME. */
  readonly realAgents?: boolean;
}

export interface Stack {
  readonly driver: ScenarioDriver;
  readonly shellyHome: string;
  /** Lines the fake agent was prompted with, if the scenario records them (FAKE_ACP_PROMPT_LOG). */
  readonly promptLog: string;
  /** The daemon's pid, once one is running. */
  daemonPid(): number | undefined;
  /** Stop Shelly, then the daemon, and remove the throwaway directories. */
  stop(): Promise<void>;
}

/** A config.json with the fake ACP agent as the default agent. */
export const fakeAgentConfig = (scenario = E2E_SCENARIO, promptLog?: string): Record<string, unknown> => ({
  defaultAgent: 'fake',
  agents: {
    fake: {
      name: 'Fake Agent',
      command: process.execPath,
      args: ['--import', TSX, FAKE_AGENT, '--scenario', scenario],
      ...(promptLog ? { env: { FAKE_ACP_PROMPT_LOG: promptLog } } : {}),
    },
  },
});

/** Driver options for a scenario (`pnpm scenario`): the fake agent as default, and the fake claude on PATH. */
export const scenarioOptions = (options: DriverOptions = {}): DriverOptions => {
  const bin = mkdtempSync(join(tmpdir(), 'shelly-bin-'));
  writeFakeClaude(bin);
  process.once('exit', () => rmSync(bin, { recursive: true, force: true }));
  return {
    ...options,
    config: { ...fakeAgentConfig(), ...options.config },
    env: { PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}`, ...options.env },
  };
};

/** Put the fake `claude` (fast mode's stream-json protocol) in `bin`, for a PATH. */
export const writeFakeClaude = (bin: string): void => {
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'claude'), `#!/bin/sh\nexec "${process.execPath}" "${FAKE_CLAUDE}" "$@"\n`);
  chmodSync(join(bin, 'claude'), 0o755);
};

/** Short, since the socket path under it must fit in 104 bytes. */
const shortTemp = (prefix: string): string => mkdtempSync(join(tmpdir(), prefix));

export const startStack = async (options: StackOptions = {}): Promise<Stack> => {
  const shellyHome = shortTemp('she-');
  const bin = join(shellyHome, 'test-bin');
  const promptLog = join(shellyHome, 'prompts.ndjson');
  mkdirSync(bin, { recursive: true });
  const env: Record<string, string> = {
    SHELLY_HOME: shellyHome,
    // The daemon goes away on its own soon after the test, if stop() never ran.
    SHELLY_DAEMON_IDLE_MS: '60000',
    SHELLY_DAEMON_START_TIMEOUT_MS: '20000',
    ...options.env,
  };
  if (!options.realAgents) {
    writeFakeClaude(bin);
    const config = { ...fakeAgentConfig(options.scenario, promptLog), ...options.config };
    writeFileSync(join(shellyHome, 'config.json'), JSON.stringify(config, null, 2));
    env.PATH = `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}`;
    Object.assign(env, options.fakeClaudeEnv);
  } else if (options.config) {
    writeFileSync(join(shellyHome, 'config.json'), JSON.stringify(options.config, null, 2));
  }

  let driver: ScenarioDriver;
  try {
    driver = await ScenarioDriver.start({ ...options, env });
  } catch (error) {
    await stopDaemonIn(shellyHome);
    rmSync(shellyHome, { recursive: true, force: true });
    throw error;
  }
  let stopped = false;
  return {
    driver,
    shellyHome,
    get promptLog() {
      return existsSync(promptLog) ? readFileSync(promptLog, 'utf8') : '';
    },
    daemonPid: () => readLock(shellyPaths({ SHELLY_HOME: shellyHome }).lock)?.pid,
    async stop() {
      if (stopped) {
        return;
      }
      stopped = true;
      // Stops the daemon too.
      await driver.close();
      rmSync(shellyHome, { recursive: true, force: true });
    },
  };
};

export { stopDaemonIn as stopDaemon } from '../tools/scenario.js';
