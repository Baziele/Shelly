import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { prepareShellIntegration } from './shell-integration.js';

describe('prepareShellIntegration', () => {
  it('finds the hook scripts shipped with Shelly', () => {
    const zsh = prepareShellIntegration('/bin/zsh', {});
    assert.ok(zsh);
    assert.ok(existsSync(join(zsh.env.ZDOTDIR ?? '', '.zshrc')));
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
    assert.deepEqual(prepareShellIntegration('fish', {}, "/opt/it's")?.args, ['--init-command', "source '/opt/it\\'s/fish/shelly.fish'"]);
  });

  it('gives every session its own nonce', () => {
    const first = prepareShellIntegration('/bin/bash', {}, '/opt/shelly');
    const second = prepareShellIntegration('/bin/bash', {}, '/opt/shelly');
    assert.match(first?.nonce ?? '', /^[0-9a-f]{24}$/);
    assert.notEqual(first?.nonce, second?.nonce);
    assert.equal(first?.env.SHELLY_NONCE, first?.nonce);
  });

  it('leaves other shells alone, and can be turned off', () => {
    assert.equal(prepareShellIntegration('/bin/sh', {}, '/opt/shelly'), undefined);
    assert.equal(prepareShellIntegration('/bin/zsh', { SHELLY_SHELL_INTEGRATION: '0' }, '/opt/shelly'), undefined);
  });
});
