import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fixtureEvents, loadFixture } from '../../../test/fixtures/thread-events/load.js';
import { EmulatedTerminal } from '../../../test/support/emulated-terminal.js';
import type { ThreadEvent } from '../../protocol/schema.js';
import { renderHistory, type HistoryOptions } from './history.js';

const fixture = loadFixture('history');
const now = Date.UTC(2026, 10, 27, 12);
const options = (width: number): HistoryOptions => ({
  agentName: 'claude',
  title: fixture.title!,
  updatedAt: now - 2 * 3_600_000,
  cwd: fixture.cwd,
  home: fixture.home,
  width,
  colorDepth: 'ansi256',
  now,
});

const shown = async (text: string, width: number): Promise<string[]> => {
  const term = new EmulatedTerminal(width, 50);
  term.write(text);
  return term.allLines();
};

describe('renderHistory', () => {
  it('prints a header rule, the request, one row per tool, the cut answer and the summary', async () => {
    const lines = await shown(await renderHistory(fixtureEvents(fixture, now), options(100)), 100);
    assert.match(lines[0]!, /^── “why does the dev server start on 3001” · claude · 2h ago ─+$/);
    assert.equal(lines[0]!.length, 100);
    assert.deepEqual(lines.slice(1, 5), [
      ':: why does the dev server start on port 3001?',
      '● Read vite.config.ts',
      '● $ lsof -i :3000',
      '● Edit vite.config.ts  +1 −1',
    ]);
    assert.ok(lines.some((line) => line.startsWith('Vite starts on 3001 because')));
    assert.match(lines.at(-3)!, /^… \(\d+ more lines\)$/);
    assert.equal(lines.at(-1), '✓ 14s · 3 tools');
    const answerRows = lines.indexOf(lines.at(-3)!) - lines.indexOf('') - 1;
    assert.equal(answerRows, 20, 'the answer is cut to 20 rows');
  });

  it('fits a narrow terminal', async () => {
    const lines = await shown(await renderHistory(fixtureEvents(fixture, now), options(44)), 44);
    assert.ok(lines.every((line) => line.length <= 44));
    assert.match(lines[0]!, /^── “why does the dev …” · claude · 2h ago ──$/);
  });

  it('ends every row with CRLF, so it prints correctly in raw mode', async () => {
    const text = await renderHistory(fixtureEvents(fixture, now), options(80));
    assert.ok(text.endsWith('\r\n'));
    assert.ok(!/[^\r]\n/.test(text));
  });

  it('replaces the answer with a `replace` chunk instead of adding to it', async () => {
    const events: ThreadEvent[] = [
      { seq: 1, type: 'turn.started', turnId: 't', text: 'greet me', at: now - 5000 },
      { seq: 2, type: 'message.chunk', turnId: 't', messageId: 'm', kind: 'text', text: 'Hel' },
      { seq: 3, type: 'message.chunk', turnId: 't', messageId: 'm', kind: 'text', text: 'Hello', replace: true },
      { seq: 4, type: 'turn.ended', turnId: 't', stopReason: 'end_turn', error: null, durationMs: 1000 },
    ];
    const lines = await shown(await renderHistory(events, options(60)), 60);
    assert.ok(lines.includes('Hello'), lines.join('\n'));
    assert.ok(!lines.some((line) => line.includes('HelHello')));
  });

  it('says so when a thread has no exchange yet', async () => {
    const lines = await shown(await renderHistory([], options(60)), 60);
    assert.equal(lines[1], 'Nothing here yet.');
  });
});
