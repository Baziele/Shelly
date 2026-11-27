import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { DaemonClient } from '../../src/client/daemon-client.js';
import { isProcessAlive, readLock } from '../../src/daemon/lock.js';
import { shellyPaths } from '../../src/protocol/paths.js';
import { probeSocket } from '../../src/protocol/probe.js';
import { type DriverOptions, ScenarioDriver } from '../tools/scenario.js';

/*
 * The whole of Shelly for end-to-end tests: the client in a real pty, the
 * daemon it starts on demand (with the real agent and fast-mode layers),
 * the fake ACP agent registered in config.json as the default agent, and
 * the fake `claude` on PATH for fast mode. Everything lives in a throwaway
 * SHELLY_HOME (and HOME), and `stop()` leaves no process behind: it asks
 * the daemon to exit, and kills it (by the pid in its lock) if it will not.
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
    writeFileSync(join(bin, 'claude'), `#!/bin/sh\nexec "${process.execPath}" "${FAKE_CLAUDE}" "$@"\n`);
    chmodSync(join(bin, 'claude'), 0o755);
    const config = {
      defaultAgent: 'fake',
      agents: {
        fake: {
          name: 'Fake Agent',
          command: process.execPath,
          args: ['--import', TSX, FAKE_AGENT, '--scenario', options.scenario ?? E2E_SCENARIO],
          env: { FAKE_ACP_PROMPT_LOG: promptLog },
        },
      },
      ...options.config,
    };
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
    await stopDaemon(shellyHome);
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
      await driver.close();
      await stopDaemon(shellyHome);
      rmSync(shellyHome, { recursive: true, force: true });
    },
  };
};

/** Ask the daemon under `shellyHome` to exit, and make sure it has (and its agents with it). */
export const stopDaemon = async (shellyHome: string): Promise<void> => {
  const paths = shellyPaths({ SHELLY_HOME: shellyHome });
  const pid = readLock(paths.lock)?.pid;
  if (await probeSocket(paths.socket)) {
    const client = new DaemonClient({ env: { ...process.env, SHELLY_HOME: shellyHome }, autoStart: false });
    await client.shutdown(false).catch(() => undefined);
    await client.dispose().catch(() => undefined);
  }
  if (pid === undefined) {
    return;
  }
  for (let waited = 0; waited < 5000 && isProcessAlive(pid); waited += 50) {
    await sleep(50);
  }
  if (isProcessAlive(pid)) {
    process.kill(pid, 'SIGKILL');
  }
};
