#!/usr/bin/env -S node --experimental-ffi --no-warnings

/*
 * Dispatch on argv before importing anything: `shelly daemon …` must not
 * load the terminal side, and plain `shelly` must not load Effect or any
 * daemon code on its startup path.
 */

const [command, ...rest] = process.argv.slice(2);

if (command === 'daemon') {
  const { main } = await import('./daemon/cli.js');
  // Exit explicitly: the daemon's runtime and sockets are done by now.
  process.exit(await main(rest));
} else {
  await import('./run-shelly.js');
}
