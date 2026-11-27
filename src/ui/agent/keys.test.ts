import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseKeys, PasteFilter } from './keys.js';

describe('PasteFilter', () => {
  it('removes bracketed pastes, following one across reads', () => {
    const filter = new PasteFilter();
    assert.deepEqual(filter.filter('a\u001b[200~pasted y\u001b[201~b'), { text: 'ab', pasted: true });
    assert.deepEqual(filter.filter('\u001b[200~start'), { text: '', pasted: true });
    assert.deepEqual(filter.filter('middle y\r'), { text: '', pasted: true });
    assert.deepEqual(filter.filter('end\u001b[201~x'), { text: 'x', pasted: true });
    assert.deepEqual(filter.filter('y'), { text: 'y', pasted: false });
  });
});

describe('PasteFilter, when the end marker is lost', () => {
  it('gives the paste up after half a second with no input, so keys are keys again', () => {
    let now = 0;
    const filter = new PasteFilter(() => now);
    assert.deepEqual(filter.filter('\u001b[200~never ends'), { text: '', pasted: true });
    now += 200;
    assert.deepEqual(filter.filter('still pasting'), { text: '', pasted: true });
    now += 600;
    assert.deepEqual(filter.filter('y'), { text: 'y', pasted: false });
  });
});

describe('parseKeys', () => {
  it('reads arrows, tab, enter, ctrl-c and characters', () => {
    assert.deepEqual(parseKeys('\u001b[C\t\r\u0003y').map((key) => key.name), ['right', 'tab', 'enter', 'ctrl-c', 'char']);
  });
});
