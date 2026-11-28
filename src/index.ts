#!/usr/bin/env -S node --experimental-ffi --no-warnings --max-semi-space-size=4

/*
 * Dispatch on argv before importing anything: `shelly daemon …` must not
 * load the terminal side, and plain `shelly` must not load Effect or any
 * daemon code on its startup path.
 *
 * --max-semi-space-size=4 (MB) keeps V8's young generation small in each
 * terminal's client: by default it grows by 30–55 MB while an agent turn
 * streams, and stays grown. It costs a little CPU on long streams. It has to
 * be a command-line flag (v8.setFlagsFromString at runtime has no effect),
 * and the daemon goes without it (see daemonExecArgv): it is one long-lived
 * process that streams more.
 */

const [command, ...rest] = process.argv.slice(2);

if (command === 'daemon') {
  const { main } = await import('./daemon/cli.js');
  // Exit explicitly: the daemon's runtime and sockets are done by now.
  process.exit(await main(rest));
} else {
  await import('./run-shelly.js');
}
