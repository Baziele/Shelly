import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { classifyReply } from './reply.js';

describe('classifyReply', () => {
  const cases: ReadonlyArray<readonly [raw: string, kind: 'command' | 'answer', text: string]> = [
    ['lsof -ti tcp:3000 | xargs kill', 'command', 'lsof -ti tcp:3000 | xargs kill'],
    ['  git reset --soft HEAD~1\n', 'command', 'git reset --soft HEAD~1'],
    ['```bash\nfind . -size +100M\n```', 'command', 'find . -size +100M'],
    ['```\ndu -sh *\n```', 'command', 'du -sh *'],
    ['Here you go:\n```sh\ntar -czf a.tgz a\n```', 'command', 'tar -czf a.tgz a'],
    ['`ls -la`', 'command', 'ls -la'],
    ['$ docker system prune', 'command', 'docker system prune'],
    ['$ cd app\n$ npm test', 'command', 'cd app\nnpm test'],
    ['echo "$ HOME"', 'command', 'echo "$ HOME"'],
    ['echo `date`', 'command', 'echo `date`'],
    ['# -print0 separates names with NUL bytes.', 'answer', '-print0 separates names with NUL bytes.'],
    ['# Line one.\n# Line two.', 'answer', 'Line one.\nLine two.'],
    ['#No space after the marker.', 'answer', 'No space after the marker.'],
    ['```\n# A fenced answer.\n```', 'answer', 'A fenced answer.'],
  ];

  for (const [raw, kind, text] of cases) {
    it(`reads ${JSON.stringify(raw)} as ${kind}`, () => assert.deepEqual(classifyReply(raw), { kind, text }));
  }
});
