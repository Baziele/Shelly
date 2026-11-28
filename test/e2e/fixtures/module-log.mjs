// Loaded with --import into a client under test: appends each module it
// resolves to $SHELLY_MODULE_LOG, one URL per line. The daemon (`… daemon`),
// which inherits the client's flags, logs nothing.
import { appendFileSync } from 'node:fs';
import { registerHooks } from 'node:module';

const log = process.env.SHELLY_MODULE_LOG;
if (log && !process.argv.slice(2).includes('daemon')) {
  const seen = new Set();
  registerHooks({
    resolve(specifier, context, next) {
      const resolved = next(specifier, context);
      if (!seen.has(resolved.url)) {
        seen.add(resolved.url);
        appendFileSync(log, `${resolved.url}\n`);
      }
      return resolved;
    },
  });
}
