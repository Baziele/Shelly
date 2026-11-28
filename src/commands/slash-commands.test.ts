import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CommandRegistry, parseSlashCommand, parseSlashQuery } from './slash-commands.js';

describe('parseSlashQuery', () => {
  it('returns the partial command name while one is being typed', () => {
    assert.equal(parseSlashQuery('/'), '');
    assert.equal(parseSlashQuery('/ru'), 'ru');
    assert.equal(parseSlashQuery('/run tests'), undefined);
    assert.equal(parseSlashQuery('why /run'), undefined);
  });
});

describe('CommandRegistry', () => {
  const registry = new CommandRegistry([
    { name: 'skills', description: '' },
    { name: 'ask', description: '' },
    { name: 'task', description: '' },
  ]);

  it('lists prefix matches before substring matches', () => {
    assert.deepEqual(registry.match('as').map((command) => command.name), ['ask', 'task']);
  });

  it('lists everything for an empty query', () => {
    assert.equal(registry.match('').length, 3);
  });
});

describe('parseSlashCommand', () => {
  it('splits a known command from its arguments', () => {
    assert.deepEqual(parseSlashCommand('/rename  Fix the build '), { name: 'rename', args: 'Fix the build' });
    assert.deepEqual(parseSlashCommand('/threads'), { name: 'threads', args: '' });
  });

  it('leaves anything else to the agent', () => {
    assert.equal(parseSlashCommand('/etc/hosts is empty?'), undefined);
    assert.equal(parseSlashCommand('/nope'), undefined);
    assert.equal(parseSlashCommand('what does /new do'), undefined);
  });
});
