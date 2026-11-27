import { acquireDaemonLock, type LockMechanism } from '../lock.js';

/*
 * For lock tests: take the daemon lock in a process of its own, print the
 * result as one JSON line, then hold it until killed or stdin closes.
 */
const [path, mechanism] = process.argv.slice(2);
const result = await acquireDaemonLock(path!, { mechanism: (mechanism as LockMechanism | undefined) ?? 'auto' });
process.stdout.write(`${JSON.stringify(result.acquired ? { acquired: true, mechanism: result.lock.mechanism } : result)}\n`);
if (result.acquired) {
  process.stdin.resume();
  process.stdin.on('end', () => {
    result.lock.release();
    process.exit(0);
  });
}
