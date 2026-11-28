import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { redactSecrets } from './redact.js';

describe('redactSecrets', () => {
  const cases: ReadonlyArray<readonly [input: string, expected: string]> = [
    ['export OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwx', 'export OPENAI_API_KEY=[redacted]'],
    ['ANTHROPIC_API_KEY="sk-ant-api03-abcdefghijklmnopqrstuvwxyz"', 'ANTHROPIC_API_KEY="[redacted]"'],
    ['git clone https://ghp_abcdefghijklmnopqrstuvwxyz0123456789@github.com/x/y', 'git clone https://[redacted]@github.com/x/y'],
    ['curl -H "Authorization: Bearer abc.def.ghi-jklmnop" api.test', 'curl -H "Authorization: Bearer [redacted]" api.test'],
    ['postgres://admin:hunter22@db.internal:5432/app', 'postgres://admin:[redacted]@db.internal:5432/app'],
    ['"password": "correcthorse"', '"password": "[redacted]"'],
    ['mysql --password=s3cretpass -u root', 'mysql --password=[redacted] -u root'],
    ['aws_access_key_id = AKIAIOSFODNN7EXAMPLE', 'aws_access_key_id = [redacted]'],
    ['-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk\n-----END OPENSSH PRIVATE KEY-----\nafter', '-----BEGIN PRIVATE KEY----- [redacted]\nafter'],
  ];

  for (const [input, expected] of cases) {
    it(`masks ${input.split('\n')[0]}`, () => assert.equal(redactSecrets(input), expected));
  }

  it('stays linear on long runs of word characters', () => {
    // Compare growth rather than wall time, so a busy machine cannot fail it:
    // 8x the input must cost well under 64x (what backtracking would cost).
    const runs = (scale: number): string[] =>
      ['a.'.repeat(4000 * scale), '1.2.3.'.repeat(1250 * scale), '0123abcd-'.repeat(875 * scale), 'x'.repeat(8000 * scale)];
    const time = (inputs: string[]): number => {
      const started = performance.now();
      for (const input of inputs) {
        redactSecrets(input);
      }
      return performance.now() - started;
    };
    time(runs(1)); // warm up the regex engine
    const small = Math.max(time(runs(1)), 1);
    const large = time(runs(8));
    assert.ok(large < 500 || large / small < 24, `8x the input took ${Math.round(large / small)}x as long (${Math.round(large)}ms)`);
  });

  it('leaves ordinary text alone', () => {
    const text = 'max_tokens=1000 PWD=/Users/me/project tokens: 12 ls -la ~/.ssh git push origin main';
    assert.equal(redactSecrets(text), text);
  });
});
