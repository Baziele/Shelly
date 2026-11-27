import * as Context from 'effect/Context';
import * as Layer from 'effect/Layer';
import { shellyPaths, type ShellyPaths } from '../protocol/paths.js';

/** Where the daemon keeps its state. Tests provide a temporary SHELLY_HOME. */
export class DaemonPaths extends Context.Service<DaemonPaths, ShellyPaths>()('shelly/daemon/DaemonPaths') {}

export const layer = (env: NodeJS.ProcessEnv = process.env): Layer.Layer<DaemonPaths> =>
  Layer.succeed(DaemonPaths, shellyPaths(env));
