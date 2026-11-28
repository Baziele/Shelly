import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { classifyReply, looksLikeProse } from './reply.js';

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

  it('shows a prose reply instead of putting it on the line', () => {
    const raw = 'Use `du -sh * | sort -h` — it lists sizes of everything here, smallest first.';
    assert.deepEqual(classifyReply(raw), { kind: 'answer', text: raw });
    assert.deepEqual(classifyReply('```\nRun `git status` to see what changed.\n```').kind, 'answer');
  });
});

describe('looksLikeProse', () => {
  // Real commands, including ones that look a little like sentences. Never prose.
  const commands = [
    'ls -la',
    'du -sh * | sort -h',
    "Rscript -e 'print(1)'",
    'Rscript analysis.R',
    'R --vanilla < script.R',
    'R CMD INSTALL mypkg',
    'Xvfb :99 -screen 0 1280x1024x24 &',
    'echo "Hello. World."',
    'git commit -m "Fix the bug. Add a test — finally."',
    "echo 'It works — really. Yes.'",
    "find . -name '*.log' -delete",
    'cp notes.txt .',
    'git add .',
    'cd ..',
    'echo `date`',
    'kill `cat app.pid`',
    'for f in `ls *.txt`; do echo $f; done',
    '`which python3` --version',
    'Get-ChildItem -Recurse | Sort-Object Length -Descending',
    'Set-Location C:\\Users',
    "printf 'Done.\\n'",
    "cat > notes.txt <<'EOF'\nThis is a note. It has two sentences — and a dash.\nEOF",
    "cat <<EOF > todo.md\nUse the new API. Then ship it.\nEOF\nwc -l todo.md",
    'python3 -c "print(\'Hi. There.\')"',
    'git commit -m "First line\n\nThis explains why. It has sentences."',
    'tar -czf a.tgz a',
    "ssh user@host 'uptime'",
    'open -a Safari https://example.com',
    'echo done.',
    'npm run build -- --watch',
    'FOO=bar make test',
    'sudo lsof -iTCP:3000 -sTCP:LISTEN',
    'git log --oneline -5',
    `osascript -e 'tell application "Finder" to activate'`,
    'curl -fsSL https://example.com/install.sh | sh',
    'grep -rn "TODO: fix this. Later." src',
    "grep -i 'can\\'t connect' app.log",
    'tr a-z A-Z <<< "make it loud"',
    'mv "My Notes.txt" notes.txt',
    // The expected replies from test/eval/fast-eval.ts.
    'find ~ -type f -size +500M',
    'lsof -ti tcp:8080 | xargs kill',
    'git reset --soft HEAD~1',
    'zip -r photos.zip photos',
    'tail -f app.log | grep --line-buffered ERROR',
    'docker container prune -f && docker image prune -f',
    'grep -rn "TODO" src --include="*.ts"',
    'grep -rc "TODO" src --include="*.ts"',
    'rsync -avn --delete ./site/ deploy@example.com:/var/www/site/',
    "find . -name '*.log' -mtime +7 -print0 | xargs -0 rm",
    'git push --set-upstream origin feature/login',
    'npm run build',
    'ps aux --sort=-%mem | head',
    'set -gx FOO bar',
  ];

  // Answers a model gave without the `# ` convention. Never on the line.
  const prose = [
    'Use `du -sh * | sort -h` — it lists sizes of everything here, smallest first.',
    'Run `git status` to see what changed.',
    'You can use lsof -i :3000 to find it.',
    'This command lists all files.',
    'To free the port, kill the process using it.',
    'The -print0 flag separates names with NUL bytes.',
    'It lists files by size.',
    '`du -sh *` lists the size of each item',
    'ls -la shows hidden files too. Use it often.',
    'lsof -ti tcp:3000 — then pipe it to kill',
    "Sorry, I can't do that as a command.",
    "I don't know which file you mean.",
    "Here's how: run make clean first.",
    'Sure! ls -la',
    'There is no single command for that.',
    'git fetch downloads; git pull also merges.',
    'ls -la\nThis lists all files, including hidden ones.',
    'Lists every file larger than 100MB.',
    'Both work, but fetch is safer.',
    'Unfortunately macOS has no such flag.',
    'find . -size +100M – that finds big files',
    'Note: this deletes files permanently.',
    "Don't run that as root.",
    'Try `brew install jq` first, then rerun.',
  ];

  for (const command of commands) {
    it(`keeps ${JSON.stringify(command)} a command`, () => assert.equal(looksLikeProse(command), false));
  }
  for (const text of prose) {
    it(`reads ${JSON.stringify(text)} as prose`, () => assert.equal(looksLikeProse(text), true));
  }
});
