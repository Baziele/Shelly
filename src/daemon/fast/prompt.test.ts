import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ContextCommand, FastInput } from '../../protocol/schema.js';
import { buildFastMessage } from './prompt.js';

const base: FastInput = {
  instruction: 'find files over 100MB',
  buffer: '',
  cwd: '/home/me/project',
  environment: { os: 'Linux 6.8.0 (x64)', shell: 'bash', shellVersion: 'GNU bash, version 5.2.21', terminal: null },
  recentCommands: [],
};

const command = (overrides: Partial<ContextCommand>): ContextCommand => ({
  id: 1,
  command: 'npm test',
  cwd: '/home/me/project',
  exitCode: 0,
  durationMs: 10,
  output: '',
  omittedLines: 0,
  usedFullScreen: false,
  ...overrides,
});

describe('buildFastMessage', () => {
  it('gives the shell, OS and folder, and ends with the request', () => {
    assert.equal(buildFastMessage(base), [
      '<os>Linux 6.8.0 (x64)</os>',
      '<shell>bash (GNU bash, version 5.2.21)</shell>',
      '<cwd>/home/me/project</cwd>',
      '<request>find files over 100MB</request>',
    ].join('\n'));
  });

  it('includes the line being edited', () => {
    const message = buildFastMessage({ ...base, instruction: 'make it recursive', buffer: 'grep TODO src' });
    assert.match(message, /<editing>grep TODO src<\/editing>\n<request>make it recursive<\/request>$/);
  });

  it('asks to fix or complete the line when there is no instruction', () => {
    assert.match(buildFastMessage({ ...base, instruction: ' ', buffer: 'git psuh' }), /<request>Fix or complete the line I am editing.<\/request>$/);
  });

  it('includes the last two commands with exit codes and the end of their output', () => {
    const output = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join('\n');
    const message = buildFastMessage({
      ...base,
      recentCommands: [
        command({ id: 1, command: 'ls' }),
        command({ id: 2, command: 'cd build' }),
        command({ id: 3, command: 'npm run biuld', exitCode: 1, output }),
      ],
    });
    assert.ok(!message.includes('$ ls\n'), 'only the last two commands');
    assert.match(message, /<command exit="0" cwd="\/home\/me\/project">\n\$ cd build\n<\/command>/);
    assert.match(message, /<command exit="1" cwd="\/home\/me\/project">\n\$ npm run biuld\nline 16\n[\s\S]*line 40\n<\/command>/);
    assert.ok(!message.includes('line 15\n'));
  });

  it('says when a full-screen program left no output', () => {
    const message = buildFastMessage({ ...base, recentCommands: [command({ command: 'vim x', usedFullScreen: true, exitCode: null })] });
    assert.match(message, /<command exit="unknown" cwd="[^"]+">\n\$ vim x\n\(full-screen program; output not captured\)\n<\/command>/);
  });
});
