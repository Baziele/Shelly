import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** How to start a shell so its hooks report commands to Shelly. */
export interface ShellIntegration {
  readonly args: readonly string[];
  /** Variables to add to the shell's environment. */
  readonly env: Readonly<Record<string, string>>;
  /** Proves a marker came from the hooks, not from program output. */
  readonly nonce: string;
}

const SCRIPTS_DIR = 'shell-integration';

/**
 * The hook scripts ship next to the code: two levels above this file in the
 * source tree, one above the bundle in dist/.
 */
const findScriptsDir = (): string | undefined => {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 4; depth++) {
    const candidate = join(dir, SCRIPTS_DIR);
    if (existsSync(join(candidate, 'zsh', '.zshenv'))) {
      return candidate;
    }
    dir = dirname(dir);
  }
  return undefined;
};

const fishQuote = (text: string): string => `'${text.replace(/[\\']/g, '\\$&')}'`;

/**
 * Works out how to launch `shell` with Shelly's hooks loaded on top of the
 * user's own configuration. Returns undefined for shells without hooks (or
 * when SHELLY_SHELL_INTEGRATION=0); those run as before, just unrecorded.
 *
 * `lineFile` is where Shelly leaves text for the hooks to put on the input
 * line (see line-editor.ts). Like the nonce, the hooks take it out of the
 * environment before anything else starts.
 */
export const prepareShellIntegration = (
  shell: string,
  env: NodeJS.ProcessEnv,
  scriptsDir = findScriptsDir(),
  lineFile?: string,
): ShellIntegration | undefined => {
  if (env.SHELLY_SHELL_INTEGRATION === '0' || !scriptsDir) {
    return undefined;
  }

  const nonce = randomBytes(12).toString('hex');
  const lineFileEnv: Record<string, string> = lineFile === undefined ? {} : { SHELLY_LINE_FILE: lineFile };
  switch (basename(shell).replace(/^-/, '')) {
    case 'zsh':
      return {
        args: [],
        env: {
          ZDOTDIR: join(scriptsDir, 'zsh'),
          SHELLY_NONCE: nonce,
          ...lineFileEnv,
          ...(env.ZDOTDIR === undefined ? {} : { SHELLY_USER_ZDOTDIR: env.ZDOTDIR }),
        },
        nonce,
      };
    case 'bash':
      return {
        args: ['--rcfile', join(scriptsDir, 'bash', 'shelly.bash')],
        env: { SHELLY_NONCE: nonce, ...lineFileEnv },
        nonce,
      };
    case 'fish':
      // fish reads the hooks after config.fish, so the nonce travels in the
      // command itself rather than through anything config.fish could start.
      return {
        args: [
          '--init-command',
          [
            `set -g __shelly_nonce ${nonce}`,
            ...(lineFile === undefined ? [] : [`set -g __shelly_line_file ${fishQuote(lineFile)}`]),
            `source ${fishQuote(join(scriptsDir, 'fish', 'shelly.fish'))}`,
          ].join('; '),
        ],
        env: {},
        nonce,
      };
    default:
      return undefined;
  }
};
