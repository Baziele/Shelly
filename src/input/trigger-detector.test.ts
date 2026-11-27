import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TriggerDetector, type TriggerAction } from './trigger-detector.js';

const detector = (isEnabled = () => true) => new TriggerDetector({ triggers: ['::', '__'], isEnabled });
const forwarded = (actions: TriggerAction[]): string =>
  actions.filter((action) => action.type === 'forward').map((action) => action.data).join('');
const triggered = (actions: TriggerAction[]) => actions.find((action) => action.type === 'trigger');

describe('TriggerDetector', () => {
  it('fires on a trigger typed at an empty line', () => {
    const subject = detector();
    assert.deepEqual(subject.push(':'), []);
    assert.equal(subject.isHolding, true);
    assert.deepEqual(subject.push(':'), [{ type: 'trigger', trigger: '::', remainder: '' }]);
  });

  it('fires when the trigger and following text arrive in one chunk', () => {
    assert.deepEqual(detector().push('::how do I'), [{ type: 'trigger', trigger: '::', remainder: 'how do I' }]);
  });

  it('knows a line Shelly set, so clearing it brings the triggers back', () => {
    const subject = detector();
    subject.markLineTyped(3);
    assert.equal(triggered(subject.push('::')), undefined, 'not at an empty line');
    subject.markLineTyped(3);
    subject.push('\u0015');
    assert.equal(triggered(subject.push('__'))?.type, 'trigger');
  });

  it('ignores triggers in the middle of a command', () => {
    const subject = detector();
    assert.equal(forwarded(subject.push('std::vector')), 'std::vector');
    assert.equal(triggered(subject.push('::')), undefined);
  });

  it('releases a held character that does not complete a trigger', () => {
    const subject = detector();
    subject.push(':');
    assert.equal(forwarded(subject.push('q')), ':q');
    assert.equal(subject.isHolding, false);
  });

  it('hands held characters back on release()', () => {
    const subject = detector();
    subject.push('_');
    assert.equal(subject.release(), '_');
    assert.equal(triggered(subject.push('__')), undefined, 'the line now contains "_"');
  });

  it('re-arms after Enter, Ctrl+C, and backspacing to an empty line', () => {
    for (const reset of ['ls\r', 'oops\u0003', 'ab\u007f\u007f']) {
      const subject = detector();
      subject.push(reset);
      assert.ok(triggered(subject.push('::')), `after ${JSON.stringify(reset)}`);
    }
  });

  it('stays off after keys it cannot follow, until a fresh line', () => {
    const subject = detector();
    subject.push('\u001b[A'); // history recall: the line may hold anything
    assert.equal(triggered(subject.push('::')), undefined);
    subject.push('\r');
    assert.ok(triggered(subject.push('::')));
  });

  it("ignores the terminal's replies to the shell's queries", () => {
    const replies = [
      '\u001b[?62;22c', // device attributes
      '\u001b[?0u', // keyboard protocol flags
      '\u001b[?2026;2$y', // mode report
      '\u001b[12;5R', // cursor position
      '\u001b[I', // focus in
      '\u001b]11;rgb:0000/0000/0000\u001b\\', // background color
      '\u001bP1+r696e646e=78\u001b\\', // capability
    ];
    for (const reply of replies) {
      const subject = detector();
      assert.equal(forwarded(subject.push(reply)), reply);
      assert.ok(triggered(subject.push('::')), `after ${JSON.stringify(reply)}`);
    }

    // Even arriving between the two characters of a trigger.
    const subject = detector();
    const actions = subject.push(':\u001b[?62c:');
    assert.equal(forwarded(actions), '\u001b[?62c');
    assert.ok(triggered(actions));
  });

  it('does not fire inside a bracketed paste', () => {
    assert.equal(triggered(detector().push('\u001b[200~::x\u001b[201~')), undefined);
  });

  it('does not fire on a line that was put back until a fresh line starts', () => {
    const subject = detector();
    subject.markLineUnknown();
    assert.equal(forwarded(subject.push('::')), '::');
    subject.push('\r');
    assert.ok(triggered(subject.push('::')));
  });

  it('defers to isEnabled, e.g. when vim owns the terminal', () => {
    assert.equal(forwarded(detector(() => false).push('::')), '::');
  });
});
