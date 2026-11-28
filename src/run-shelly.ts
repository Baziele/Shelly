/* The interactive `shelly`: the user's shell in a pty, with Shelly around it. Loaded by index.ts. */
import { defaultShell } from './shell/shell-session.js';
import { Shelly } from './shelly.js';
import { HostTerminal } from './terminal/host-terminal.js';

const host = new HostTerminal();

if (!host.isInteractive) {
  process.stderr.write('shelly: needs an interactive terminal (stdin and stdout must be a TTY).\n');
  process.exit(1);
}

// Whatever goes wrong, never leave the user's terminal stuck in raw mode.
const crash = (error: unknown): never => {
  host.stop();
  process.stderr.write(`\r\nshelly crashed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\r\n`);
  process.exit(1);
};
process.on('uncaughtException', crash);
process.on('unhandledRejection', crash);

const shelly = new Shelly({
  host,
  shell: defaultShell(),
  cwd: process.cwd(),
  env: process.env,
});

for (const signal of ['SIGHUP', 'SIGTERM'] as const) {
  process.on(signal, () => shelly.terminate());
}

// Exit with the shell. run() has already said goodbye to the daemon (bounded
// in time); a daemon connection still being made (a slow start, or one that
// never comes) must not keep the terminal waiting.
process.exit(await shelly.run());
