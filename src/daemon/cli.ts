import { DaemonClient, DaemonNotRunning } from '../client/daemon-client.js';

/*
 * `shelly daemon`            run the daemon in the foreground
 * `shelly daemon status`     print what the running daemon reports
 * `shelly daemon stop`       ask it to stop
 */

const USAGE = 'usage: shelly daemon [status|stop]\n';

const withClient = async (body: (client: DaemonClient) => Promise<number>): Promise<number> => {
  const client = new DaemonClient({ autoStart: false });
  try {
    return await body(client);
  } catch (error) {
    if (error instanceof DaemonNotRunning) {
      process.stdout.write('Shelly daemon is not running.\n');
      return 1;
    }
    throw error;
  } finally {
    await client.close();
  }
};

export const main = async (args: readonly string[]): Promise<number> => {
  const [command, ...rest] = args;
  if (rest.length > 0) {
    process.stderr.write(USAGE);
    return 2;
  }
  switch (command) {
    case undefined: {
      const { runDaemon } = await import('./main.js');
      return runDaemon();
    }
    case 'status':
      return withClient(async (client) => {
        const status = await client.status();
        const lines = [
          `pid:              ${status.pid}`,
          `version:          ${status.daemonVersion}`,
          `started:          ${new Date(status.startedAt).toISOString()}`,
          `clients:          ${status.clients}`,
          `running turns:    ${status.runningTurns}`,
          `agent processes:  ${status.agentProcesses}`,
          `fast workers:     ${status.fastWorkers}`,
        ];
        process.stdout.write(`${lines.join('\n')}\n`);
        return 0;
      });
    case 'stop':
      return withClient(async (client) => {
        await client.shutdown(false);
        await client.close();
        await client.waitUntilStopped();
        process.stdout.write('Shelly daemon stopped.\n');
        return 0;
      });
    default:
      process.stderr.write(USAGE);
      return 2;
  }
};
