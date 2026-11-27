import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { prepareShellIntegration } from './shell-integration.js';

describe('prepareShellIntegration', () => {
  it('finds the hook scripts shipped with Shelly', () => {
    const zsh = prepareShellIntegration('/bin/zsh', {});
    assert.ok(zsh);
    assert.ok(existsSync(join(zsh.env.ZDOTDIR ?? '', '.zshenv')));
  });

  it('points zsh at the hooks and remembers the user ZDOTDIR', () => {
    const plain = prepareShellIntegration('/bin/zsh', {}, '/opt/shelly');
    assert.deepEqual(plain?.args, []);
    assert.equal(plain?.env.ZDOTDIR, '/opt/shelly/zsh');
    assert.equal(plain?.env.SHELLY_USER_ZDOTDIR, undefined);

    const custom = prepareShellIntegration('/bin/zsh', { ZDOTDIR: '/home/me/.config/zsh' }, '/opt/shelly');
    assert.equal(custom?.env.SHELLY_USER_ZDOTDIR, '/home/me/.config/zsh');
  });

  it('loads the hooks as bash and fish startup files', () => {
    assert.deepEqual(prepareShellIntegration('/usr/local/bin/bash', {}, '/opt/shelly')?.args, ['--rcfile', '/opt/shelly/bash/shelly.bash']);
    const fish = prepareShellIntegration('fish', {}, "/opt/it's");
    assert.deepEqual(fish?.args, ['--init-command', `set -g __shelly_nonce ${fish?.nonce}; source '/opt/it\\'s/fish/shelly.fish'`]);
    assert.deepEqual(fish?.env, {}, 'the nonce stays out of the environment');
  });

  it('tells the hooks where the line file is, outside the environment for fish', () => {
    assert.equal(prepareShellIntegration('/bin/zsh', {}, '/opt/shelly', '/tmp/x/line')?.env.SHELLY_LINE_FILE, '/tmp/x/line');
    assert.equal(prepareShellIntegration('/bin/bash', {}, '/opt/shelly', '/tmp/x/line')?.env.SHELLY_LINE_FILE, '/tmp/x/line');
    const fish = prepareShellIntegration('fish', {}, '/opt/shelly', "/tmp/it's/line");
    assert.deepEqual(fish?.env, {});
    assert.match(fish?.args[1] ?? '', /; set -g __shelly_line_file '\/tmp\/it\\'s\/line'; source /);
  });

  it('gives every session its own nonce', () => {
    const first = prepareShellIntegration('/bin/bash', {}, '/opt/shelly');
    const second = prepareShellIntegration('/bin/bash', {}, '/opt/shelly');
    assert.match(first?.nonce ?? '', /^[0-9a-f]{24}$/);
    assert.notEqual(first?.nonce, second?.nonce);
    assert.equal(first?.env.SHELLY_NONCE, first?.nonce, 'bash removes it from its environment first thing');
  });

  it('leaves other shells alone, and can be turned off', () => {
    assert.equal(prepareShellIntegration('/bin/sh', {}, '/opt/shelly'), undefined);
    assert.equal(prepareShellIntegration('/bin/zsh', { SHELLY_SHELL_INTEGRATION: '0' }, '/opt/shelly'), undefined);
  });
});
