#!/usr/bin/env node

import * as pty from 'node-pty';
import * as os from 'os';
import { createContext } from './context.js';

const shell = process.env.SHELL || (os.platform() === 'win32' ? 'powershell.exe' : 'bash');
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

let context = createContext();
let history = '';

// We recieve data from the shell and write it to the terminal
ptyProcess.onData((data: string) => {
  process.stdout.write(data);
  history += data;
});

// We recieve data from the terminal and write it to the shell
process.stdin.on('data', (data: Buffer) => {
ptyProcess.write(data);
})

process.stdout.on('resize', () => {
  const cols = process.stdout.columns || 80;
  const rows = process.stdout.rows || 30;
  ptyProcess.resize(cols, rows);
})

ptyProcess.onExit(({exitCode}) => {
  if (process.stdin.isTTY){
    process.stdin.setRawMode(false);
  }
  process.stdin.pause();
   console.log(`Shell exited with code ${exitCode}`);
   console.log("context:", context);
process.exit(exitCode);
})