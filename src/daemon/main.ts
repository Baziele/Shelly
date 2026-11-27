import { chmodSync, mkdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import * as Deferred from 'effect/Deferred';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as Layer from 'effect/Layer';
import { shellyPaths } from '../protocol/paths.js';
import { probeSocket } from '../protocol/probe.js';
import * as AgentDirectory from './AgentDirectory.js';
import * as DaemonLog from './DaemonLog.js';
import * as DaemonPaths from './DaemonPaths.js';
import * as Lifecycle from './Lifecycle.js';
import { acquireLock, type LockHolder, releaseLock } from './lock.js';
import * as Placeholders from './placeholders.js';
import * as DaemonServer from './server.js';
import type { AgentRuntime, FastService } from './services.js';
import * as ShellyConfigFile from './ShellyConfigFile.js';
import * as ThreadStore from './store/ThreadStore.js';
import { ensureThreadHome } from './thread-home.js';
import * as ThreadService from './ThreadService.js';

/*
 * `shelly daemon`: one per user. Takes the lock, serves the socket until a
 * client, a signal or the idle timer asks it to stop, then closes in order:
 * the socket first (no new requests), then running turns (ended as
 * `interrupted`), then agents and the store.
 */

export const DEFAULT_IDLE_MS = 10 * 60 * 1000;
/** A live pid holding the lock this long with nothing on the socket is not a daemon (its pid was reused). */
const LOCK_GRACE_MS = 10_000;

/** macOS allows 104 bytes for a unix socket path, including the terminator. */
const MAX_SOCKET_PATH_BYTES = 103;

type AgentLayers = Layer.Layer<AgentRuntime | FastService>;

/**
 * The agent layers. Tests point SHELLY_DAEMON_TEST_RUNTIME at a module that
 * exports `layer` (fakes for both services); nothing else reads it.
 */
const loadAgentLayers = async (env: NodeJS.ProcessEnv): Promise<AgentLayers> => {
  const testModule = env.SHELLY_DAEMON_TEST_RUNTIME;
  if (testModule) {
    const loaded = (await import(pathToFileURL(testModule).href)) as { layer: AgentLayers };
    return loaded.layer;
  }
  // The real AgentRuntime (src/daemon/agents/) and FastService (src/daemon/fast/) replace these.
  return Placeholders.layer;
};

export const makeDaemonLayer = (env: NodeJS.ProcessEnv, agentLayers: AgentLayers, shutdown: Deferred.Deferred<string>) => {
  const idleMs = Number(env.SHELLY_DAEMON_IDLE_MS) > 0 ? Number(env.SHELLY_DAEMON_IDLE_MS) : DEFAULT_IDLE_MS;
  const paths = DaemonPaths.layer(env);
  const base = Layer.mergeAll(
    paths,
    agentLayers,
    ThreadStore.layer.pipe(Layer.provide(paths)),
    ShellyConfigFile.layer.pipe(Layer.provide(paths)),
    Lifecycle.layer(shutdown),
  );
  const services = ThreadService.layer.pipe(
    Layer.provideMerge(AgentDirectory.layer.pipe(Layer.provideMerge(base))),
  );
  return Layer.mergeAll(DaemonServer.layer, DaemonServer.idleExitLayer(idleMs)).pipe(Layer.provideMerge(services));
};

const say = (text: string): void => {
  process.stderr.write(`${new Date().toISOString()} shelly daemon: ${text}\n`);
};

const takeLock = async (lockPath: string, socketPath: string): Promise<LockHolder | undefined> => {
  const first = acquireLock(lockPath);
  if (first.acquired) {
    return undefined;
  }
  // A live holder with nothing on the socket long after it started is not a Shelly daemon.
  const answers = await probeSocket(socketPath);
  const second = acquireLock(lockPath, { isStale: (holder) => !answers && Date.now() - holder.startedAt > LOCK_GRACE_MS });
  return second.acquired ? undefined : second.holder;
};

/** Runs the daemon to completion; resolves with the process exit code. */
export const runDaemon = async (env: NodeJS.ProcessEnv = process.env): Promise<number> => {
  const paths = shellyPaths(env);
  if (Buffer.byteLength(paths.socket) > MAX_SOCKET_PATH_BYTES) {
    say(`the socket path is too long for this system (${Buffer.byteLength(paths.socket)} bytes); use a shorter SHELLY_HOME`);
    return 1;
  }
  // Everything the daemon creates (socket, database, logs) is the user's alone.
  process.umask(0o077);
  for (const dir of [paths.home, paths.runDir, paths.logs]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  chmodSync(paths.runDir, 0o700);

  const holder = await takeLock(paths.lock, paths.socket);
  if (holder) {
    say(`another daemon is running (pid ${holder.pid})`);
    return 0;
  }

  try {
    ensureThreadHome(paths.threadHome);
    const agentLayers = await loadAgentLayers(env);
    const shutdown = Deferred.makeUnsafe<string>();
    const onSignal = (signal: NodeJS.Signals) => () => {
      Deferred.doneUnsafe(shutdown, Effect.succeed(signal));
    };
    const onTerm = onSignal('SIGTERM');
    const onInt = onSignal('SIGINT');
    process.on('SIGTERM', onTerm);
    process.on('SIGINT', onInt);

    const program = Effect.gen(function* () {
      const lifecycle = yield* Lifecycle.Lifecycle;
      yield* Effect.logInfo(`started pid=${process.pid}`);
      const reason = yield* lifecycle.awaitShutdown;
      yield* Effect.logInfo(`stopping: ${reason}`);
    }).pipe(
      Effect.provide(makeDaemonLayer(env, agentLayers, shutdown)),
      Effect.provide(DaemonLog.layer(paths.daemonLog)),
    );

    const exit = await Effect.runPromiseExit(program);
    process.off('SIGTERM', onTerm);
    process.off('SIGINT', onInt);
    if (Exit.isFailure(exit)) {
      say('failed; see daemon.log');
      await Effect.runPromise(
        Effect.logError('daemon failed', exit.cause).pipe(Effect.provide(DaemonLog.layer(paths.daemonLog))),
      );
      return 1;
    }
    return 0;
  } finally {
    releaseLock(paths.lock);
  }
};
