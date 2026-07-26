#!/usr/bin/env node

import * as pty from 'node-pty';
import * as os from 'os';
import { createContext } from './context.js';
import { createHistoryLogPath, ShellHistoryManager } from './history.js';

const shell = os.platform() === 'win32'
  ? process.env.ComSpec ?? process.env.COMSPEC ?? 'powershell.exe'
  : process.env.SHELL ?? 'sh';
const env = process.env as {[key: string]: string};

if (process.stdin.isTTY){
  process.stdin.setRawMode(true);
}
process.stdin.resume();


const ptyProcess = pty.spawn(shell, [], {
  name: 'xterm-color',
  cols: process.stdout.columns || 80,
  rows: process.stdout.rows || 30,
  cwd: process.cwd(),
  env: env
});

const context = createContext();
const history = new ShellHistoryManager();

// We recieve data from the shell and write it to the terminal
ptyProcess.onData((data: string) => {
  process.stdout.write(data);
  history.recordOutput(data);
});

// We recieve data from the terminal and write it to the shell
process.stdin.on('data', (data: Buffer) => {
  history.recordInput(data);
  ptyProcess.write(data);
})

process.stdout.on('resize', () => {
  const cols = process.stdout.columns || 80;
  const rows = process.stdout.rows || 30;
  ptyProcess.resize(cols, rows);
})

ptyProcess.onExit(async ({exitCode}) => {
  if (process.stdin.isTTY){
    process.stdin.setRawMode(false);
  }
  process.stdin.pause();
  console.log(`Shell exited with code ${exitCode}`);
  console.log('context:', context);
  try {
    const logFile = await history.complete(createHistoryLogPath());
    console.log(`History written to ${logFile}`);
  } catch (error) {
    console.error('Could not write history log:', error);
  }

process.exit(exitCode);
})
