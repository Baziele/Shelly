import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { renderMarkdownRows } from './static-render.js';

const rowText = (row: ReadonlyArray<{ text: string }>): string => row.map((span) => span.text).join('').trimEnd();

describe('renderMarkdownRows', { timeout: 60_000 }, () => {
  it('lays out a very long answer whole: nothing is dropped, however tall it is', async () => {
    const paragraphs = Array.from({ length: 1500 }, (_, index) => `Paragraph ${index + 1} of the answer.`);
    const rows = await renderMarkdownRows(paragraphs.join('\n\n'), 60);
    const texts = rows.map(rowText);
    assert.equal(texts[0], 'Paragraph 1 of the answer.');
    assert.equal(texts.at(-1), 'Paragraph 1500 of the answer.');
    assert.equal(texts.filter((text) => text.startsWith('Paragraph ')).length, 1500);
  });

  it('keeps every row of a long code block', async () => {
    const code = Array.from({ length: 800 }, (_, index) => `line ${index + 1}`).join('\n');
    const rows = (await renderMarkdownRows(`\`\`\`\n${code}\n\`\`\``, 40)).map(rowText);
    assert.equal(rows.length, 800);
    assert.equal(rows.at(-1), '│ line 800');
  });

  it('keeps what fits, and says how much was left out, past the tallest layout it tries', async () => {
    const paragraphs = Array.from({ length: 100 }, (_, index) => `Paragraph ${index + 1}.`).join('\n\n');
    const rows = (await renderMarkdownRows(paragraphs, 40, 50)).map(rowText);
    assert.equal(rows[0], 'Paragraph 1.');
    assert.match(rows.at(-1)!, /^… \(\d+ more lines not shown\)$/);
    assert.ok(rows.length >= 50);
  });
});
