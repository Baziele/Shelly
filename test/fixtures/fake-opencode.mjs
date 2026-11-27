#!/usr/bin/env node
// A fake `opencode` CLI for fast-mode tests. Only `opencode service start` does
// anything: it records the fake service (FAKE_OPENCODE_URL, FAKE_OPENCODE_PASSWORD)
// in the state file, as the real CLI does when it starts the background service,
// and logs the call to FAKE_OPENCODE_LOG.
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
if (process.env.FAKE_OPENCODE_LOG) appendFileSync(process.env.FAKE_OPENCODE_LOG, `${JSON.stringify(args)}\n`);
if (args[0] === 'service' && args[1] === 'start' && process.env.FAKE_OPENCODE_URL) {
  const dir = join(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'opencode');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'service.json'), JSON.stringify({
    id: 'fake', version: '2.4.1', url: process.env.FAKE_OPENCODE_URL, pid: process.pid, password: process.env.FAKE_OPENCODE_PASSWORD,
  }));
  console.log(process.env.FAKE_OPENCODE_URL);
}
