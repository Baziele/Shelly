import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { decodePayload, ShellMarkerParser, type ShellOutputSegment } from './shell-markers.js';

const NONCE = 'n0nce';
const marker = (body: string, terminator = '\u0007'): string => `\u001b]6973;${NONCE};${body}${terminator}`;

const output = (segments: ShellOutputSegment[]): string =>
  segments.map((segment) => (segment.type === 'output' ? segment.data : '')).join('');
const events = (segments: ShellOutputSegment[]) =>
  segments.flatMap((segment) => (segment.type === 'event' ? [segment.event] : []));

describe('ShellMarkerParser', () => {
  it('passes ordinary output through untouched', () => {
    const parser = new ShellMarkerParser(NONCE);
    const text = 'hello \u001b[31mred\u001b[0m \u001b]0;title\u0007 \u001b]133;A\u001b\\';
    assert.deepEqual(parser.push(text), [{ type: 'output', data: text }]);
  });

  it('extracts events in order and strips them from the output', () => {
    const parser = new ShellMarkerParser(NONCE);
    const segments = parser.push(`before${marker('exec;ls -la')}out\r\n${marker('done;2')}${marker('cwd;/tmp', '\u001b\\')}$ `);

    assert.deepEqual(segments, [
      { type: 'output', data: 'before' },
      { type: 'event', event: { type: 'exec', command: 'ls -la' } },
      { type: 'output', data: 'out\r\n' },
      { type: 'event', event: { type: 'done', exitCode: 2 } },
      { type: 'event', event: { type: 'cwd', path: '/tmp' } },
      { type: 'output', data: '$ ' },
    ]);
  });

  it('reads the input line, whose buffer may hold semicolons, and the request it answers', () => {
    const parser = new ShellMarkerParser(NONCE);
    assert.deepEqual(events(parser.push(
      marker('line;7;a; b;100%25 ü%0A;3') + marker('line;;;0') + marker('line;2;;-1') + marker('line;x;y;') + marker('line;'),
    )), [
      { type: 'line', request: 7, line: { buffer: 'a; b;100% ü\n', cursor: 3 } },
      { type: 'line', request: undefined, line: { buffer: '', cursor: 0 } },
      { type: 'line', request: 2, line: undefined },
      { type: 'line', request: undefined, line: undefined },
      { type: 'line', request: undefined, line: undefined },
    ]);
    assert.deepEqual(events(parser.push(marker('query;5;ls ;a;2') + marker('query;6;;-1'))), [
      { type: 'line-query', request: 5, line: { buffer: 'ls ;a', cursor: 2 } },
      { type: 'line-query', request: 6, line: undefined },
    ]);
    assert.deepEqual(events(parser.push(marker('line-set;4') + marker('line-set;'))), [
      { type: 'line-set', request: 4 },
      { type: 'line-set', request: undefined },
    ]);
  });

  it('reads what the hooks can do with the line', () => {
    const parser = new ShellMarkerParser(NONCE);
    assert.deepEqual(events(parser.push(marker('line-editor;capture,set') + marker('line-editor;'))), [
      { type: 'line-editor', features: ['capture', 'set'] },
      { type: 'line-editor', features: [] },
    ]);
  });

  it('decodes percent-encoded payloads', () => {
    const parser = new ShellMarkerParser(NONCE);
    assert.deepEqual(events(parser.push(marker('exec;echo 100%25;%0Anext ünï'))), [
      { type: 'exec', command: 'echo 100%;\nnext ünï' },
    ]);
  });

  it('handles a marker split at every possible point', () => {
    const stream = `a${marker('exec;make')}b${marker('done;0')}c`;
    for (let split = 0; split <= stream.length; split++) {
      const parser = new ShellMarkerParser(NONCE);
      const segments = [...parser.push(stream.slice(0, split)), ...parser.push(stream.slice(split)), ...parser.flush()];
      assert.equal(output(segments), 'abc', `split at ${split}`);
      assert.deepEqual(events(segments), [{ type: 'exec', command: 'make' }, { type: 'done', exitCode: 0 }], `split at ${split}`);
    }
  });

  it('forwards markers with the wrong nonce, so output cannot forge events', () => {
    const parser = new ShellMarkerParser(NONCE);
    const forged = '\u001b]6973;guess;exec;rm -rf /\u0007';
    assert.deepEqual(parser.push(`x${forged}y`), [{ type: 'output', data: `x${forged}y` }]);
  });

  it('holds only a possible marker start, and can release it', () => {
    const parser = new ShellMarkerParser(NONCE);
    assert.deepEqual(parser.push('text\u001b'), [{ type: 'output', data: 'text' }]);
    assert.equal(parser.isHoldingPartialPrefix, true);
    assert.deepEqual(parser.flush(), [{ type: 'output', data: '\u001b' }]);

    parser.push('\u001b]6973;n0n');
    assert.equal(parser.isHoldingPartialPrefix, false, 'a started marker is never flushed early');
  });

  it('ignores event kinds it does not know', () => {
    const parser = new ShellMarkerParser(NONCE);
    assert.deepEqual(parser.push(`a${marker('future;x')}b`), [{ type: 'output', data: 'ab' }]);
  });

  it('drops one of its own markers that grows too long, never showing the nonce', () => {
    const parser = new ShellMarkerParser(NONCE);
    const segments = [
      ...parser.push(`before\u001b]6973;${NONCE};exec;${'x'.repeat(70_000)}`),
      ...parser.push(`${'y'.repeat(100)}\u0007after`),
    ];
    assert.equal(output(segments), 'beforeafter');
    assert.deepEqual(events(segments), []);
  });

  it('releases a lookalike as soon as it is clearly not ours', () => {
    const parser = new ShellMarkerParser(NONCE);
    assert.equal(output(parser.push('\u001b]6973;not-it Password: ')), '\u001b]6973;not-it Password: ');
    assert.equal(output(parser.push('typed')), 'typed');
  });

  it('drops one of its own markers that is cut short by another sequence', () => {
    const parser = new ShellMarkerParser(NONCE);
    assert.equal(output(parser.push(`a\u001b]6973;${NONCE};exec;ls\u001b[31mred`)), 'a\u001b[31mred');
  });
});

describe('decodePayload', () => {
  it('keeps raw bytes when the escapes are not valid UTF-8', () => {
    assert.equal(decodePayload('a%FFb'), 'aÿb');
  });
});
