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
    // A comment line above a command is not an answer: the command is kept, the comment dropped.
    ['# free port 3000\nlsof -ti tcp:3000 | xargs kill', 'command', 'lsof -ti tcp:3000 | xargs kill'],
    ['```bash\n# free port 3000\nlsof -ti tcp:3000 | xargs kill\n```', 'command', 'lsof -ti tcp:3000 | xargs kill'],
    ['```bash\nlsof -ti tcp:3000 | xargs kill\n```\n# kills whatever listens on 3000', 'command', 'lsof -ti tcp:3000 | xargs kill'],
    ['# go to the app\n$ cd app\n$ npm test', 'command', 'cd app\nnpm test'],
    ['ls -la # long listing', 'command', 'ls -la # long listing'],
    ['# One.\n\n# Two.', 'answer', 'One.\n\nTwo.'],
    // Only comments around the command go; `#` lines inside it are content (heredocs, crontabs, strings).
    ["cat > run.sh <<'EOF'\n#!/bin/sh\n# Build it\nmake\nEOF", 'command', "cat > run.sh <<'EOF'\n#!/bin/sh\n# Build it\nmake\nEOF"],
    ["# write the script\ncat > run.sh <<'EOF'\n#!/bin/sh\nmake\nEOF\n# then chmod +x it", 'command', "cat > run.sh <<'EOF'\n#!/bin/sh\nmake\nEOF"],
    ["```sh\n(crontab -l; cat <<'EOF'\n# nightly backup\n0 3 * * * ~/backup.sh\nEOF\n) | crontab -\n```", 'command', "(crontab -l; cat <<'EOF'\n# nightly backup\n0 3 * * * ~/backup.sh\nEOF\n) | crontab -"],
    ['git commit -m "Title\n\n# not a comment"', 'command', 'git commit -m "Title\n\n# not a comment"'],
  ];

  for (const [raw, kind, text] of cases) {
    it(`reads ${JSON.stringify(raw)} as ${kind}`, () => assert.deepEqual(classifyReply(raw), { kind, text }));
  }
});
