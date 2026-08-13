#!/usr/bin/env node

import * as pty from 'node-pty';
import * as os from 'os';
import { createContext } from './context.js';
import { createHistoryLogPath, ShellHistoryManager } from './history.js';
import * as readline from 'readline';

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
// const promptInterceptor = new PromptInterceptor();
let suppressShellOutput = false;

const respondToAiPrompt = (prompt: string): void => {
  setTimeout(() => {
    const response = `Dummy AI response: received "${prompt || '(empty prompt)'}".`;
    history.recordCommand(`AI prompt: ${prompt}`);
    history.recordOutput(`${response}\n`);
    process.stdout.write(`${response}\n`);

    // The intercepted line was never sent to the shell. Cancel its current
    // editor state so it redraws a clean prompt after the response.
    suppressShellOutput = true;
    ptyProcess.write('\u0003');
  }, 100);
};

const PROMPT_PREFIXES = ['__', '::'] as const;
const AI_PROMPT_DISPLAY_COLOR = '\u001b[32m';
const ANSI_RESET = '\u001b[0m';
let activeRl: readline.Interface | undefined;
const state = {
  candidateMatch: '',
  mode: shell,
  interceptedLine: '',
  intercepted: false
}

const enterAi = ()=>{
  state.mode = "ai";
   setImmediate(() => {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
      activeRl = rl;
      state.intercepted = true;
      // rl.prompt();
      rl.on('SIGINT', () => {   // Ctrl+C = cancel, not death
      exitAiMode();
      process.stdout.write('^C\r\n');
      suppressShellOutput = true;
      ptyProcess.write('\u0003');
      })

      rl.on('line', (aiprompt)=>{
        exitAiMode();
        respondToAiPrompt(aiprompt);
        // state.intercepted = false;
        // process.stdout.write(`${ANSI_RESET}\r\n`);
      })
    
  });
}

const exitAiMode = (): void => {
  activeRl?.close();
  activeRl = undefined;
  // if (undoHook) process.stdin.removeListener('keypress', undoHook);
  // undoHook = undefined;
  process.stdin.setRawMode(true);  // rl.close() turned this off  (bug #1)
  process.stdin.resume();          // rl.close() paused the stream (bug #1)
  // mode = 'shell';
  state.mode = 'shell';
  state.interceptedLine = '';
};

// We recieve data from the terminal and write it to the shell
process.stdin.on('data', async (data: Buffer) => {

  const text = typeof data === 'string' ? data : data.toString('utf8');

  for (const char of text) {
    if (state.mode === "ai") {
      
      continue;
    }

    if ((char === '_' || char === ':')) {
      if (state.candidateMatch === '') {
        // Possible start of an AI prompt prefix; see what the next char is.
        state.candidateMatch = char;
        // continue
      } else if (PROMPT_PREFIXES.some((prefix) => prefix === state.candidateMatch + char)) {
        state.candidateMatch = '';
        process.stdout.write(`${AI_PROMPT_DISPLAY_COLOR}${char}`);
        enterAi();
        continue;
      } else {
        state.candidateMatch = '';
      }
    } else {
      state.candidateMatch = '';
    }

    suppressShellOutput = false;
    ptyProcess.write(char);
  

}
})


// We recieve data from the shell and write it to the terminal
ptyProcess.onData((data: string) => {
  process.stdout.write(data);
  if (!suppressShellOutput) {
    history.recordOutput(data);
  }
});

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
