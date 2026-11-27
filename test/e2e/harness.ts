import { ScenarioDriver, lastPromptRow } from '../tools/scenario.js';

export { lastPromptRow };

export interface ShellyHarness {
  /** Send keystrokes as a terminal would: escape sequences arrive whole. */
  type(keys: string): Promise<void>;
  /** The visible screen, one string per row, trailing spaces trimmed. */
  screen(): Promise<string[]>;
  cursor(): Promise<{ row: number; col: number }>;
  /** Poll the screen until `predicate` holds, or fail with the last screen. */
  waitFor(predicate: (screen: string[]) => boolean, description: string, options?: { timeoutMs?: number }): Promise<string[]>;
  /** Everything Shelly wrote to the terminal so far. */
  raw(): string;
  close(): Promise<number>;
  /** The underlying driver, for screenshots and named keys. */
  readonly driver: ScenarioDriver;
}

export interface ShellyOptions {
  readonly cols?: number;
  readonly rows?: number;
  readonly shell?: string;
  /** A HOME holding the shell's startup files; a throwaway one when absent. */
  readonly home?: string;
  readonly env?: Readonly<Record<string, string>>;
}

/**
 * Runs Shelly in a pseudo-terminal attached to an emulated terminal
 * (xterm.js), which answers cursor position and other queries like a real
 * one; see test/tools/scenario.ts. Defaults to plain `sh` with a fixed prompt
 * so results do not depend on the user's shell configuration; other shells
 * should get a HOME whose startup files set the same prompt.
 */
export const startShelly = async (
  { cols = 80, rows = 12, shell = '/bin/sh', home, env = {} }: ShellyOptions = {},
): Promise<ShellyHarness> => {
  const driver = await ScenarioDriver.start({ cols, rows, shell, home, env });
  return {
    driver,
    type: (keys) => driver.type(keys),
    screen: () => driver.lines(),
    cursor: () => driver.cursor(),
    waitFor: (predicate, description, options) => driver.waitFor(predicate, description, options),
    raw: () => driver.raw(),
    close: () => driver.close(),
  };
};
