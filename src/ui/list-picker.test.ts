import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { lineText } from './agent/lines.js';
import { filterItems, formatPickerRows, type PickerItem } from './list-picker.js';
import { agentPickerItems, modePickerItems, threadPickerItems } from './pickers.js';

const items: PickerItem[] = [
  { id: '1', label: 'fix the build', columns: ['claude', '2m ago', '~/acme-web'] },
  { id: '2', label: 'why does the dev server start on 3001', columns: ['claude', '2h ago', 'shelly home'] },
  { id: '3', label: 'rename payments', columns: ['opencode', 'yesterday', '~/acme-api'], keywords: 'billing' },
];

describe('filterItems', () => {
  it('puts prefix matches first, then labels and keywords that contain the query', () => {
    assert.deepEqual(filterItems(items, '').map((item) => item.id), ['1', '2', '3']);
    assert.deepEqual(filterItems(items, 'R').map((item) => item.id), ['3', '2']);
    assert.deepEqual(filterItems(items, 'the').map((item) => item.id), ['1', '2']);
    assert.deepEqual(filterItems(items, 'bill').map((item) => item.id), ['3']);
    assert.deepEqual(filterItems(items, 'zzz'), []);
  });
});

describe('formatPickerRows', () => {
  it('aligns columns and marks the selection', () => {
    const rows = formatPickerRows(items, 1, 100, '').map(lineText);
    assert.deepEqual(rows, [
      '  fix the build                          claude    2m ago     ~/acme-web',
      '› why does the dev server start on 3001  claude    2h ago     shelly home',
      '  rename payments                        opencode  yesterday  ~/acme-api',
    ]);
  });

  it('shortens labels, then cuts the last column, then drops columns on narrow screens', () => {
    for (const width of [60, 44, 30, 20]) {
      for (const row of formatPickerRows(items, 0, width, '').map(lineText)) {
        assert.ok(row.length <= width, `${width}: ${row}`);
      }
    }
    assert.equal(lineText(formatPickerRows(items, 0, 44, '')[1]!), '  why does the dev serv…  claude    2h ago');
    assert.equal(lineText(formatPickerRows(items, 0, 20, '')[0]!), '› fix the build');
  });

  it('says when nothing matches', () => {
    assert.deepEqual(formatPickerRows([], 0, 40, 'No threads match').map(lineText), ['  No threads match']);
  });
});

describe('picker items', () => {
  it('lists threads newest first with agent, time or status, and place', () => {
    const now = Date.UTC(2026, 10, 27, 12);
    const thread = (id: string, updatedAgo: number, extra: Record<string, unknown> = {}) => ({
      id, title: `thread ${id}`, agentId: 'claude', location: 'folder' as const, cwd: '/home/dev/acme', createdAt: 0,
      updatedAt: now - updatedAgo, status: 'idle' as const, turnCount: 1, attachedBy: null, ...extra,
    });
    const rows = threadPickerItems([
      thread('a', 7_200_000),
      thread('b', 60_000, { status: 'running', location: 'home' }),
    ], { cwd: '/home/dev/acme', home: '/home/dev', currentThreadId: 'a', now });
    assert.deepEqual(rows.map((row) => [row.label, ...(row.columns ?? []), row.current]), [
      ['thread b', 'claude', '● working', 'shelly home', false],
      ['thread a', 'claude', '2h ago', '.', true],
    ]);
  });

  it('marks the default agent and explains unavailable ones', () => {
    const rows = agentPickerItems([
      { id: 'claude', name: 'Claude Code', available: true, unavailableReason: null, supportsFast: true, isDefault: true },
      { id: 'opencode', name: 'OpenCode', available: false, unavailableReason: 'not installed', supportsFast: false, isDefault: false },
    ]);
    assert.deepEqual(rows.map((row) => [row.label, row.columns?.[0], row.current]), [
      ['Claude Code', 'default', true],
      ['OpenCode', 'not installed', false],
    ]);
  });

  it('marks the current mode', () => {
    const rows = modePickerItems([{ id: 'default', name: 'Default', description: null }, { id: 'plan', name: 'Plan', description: 'Read only' }], 'plan');
    assert.deepEqual(rows.map((row) => row.current), [false, true]);
  });
});
