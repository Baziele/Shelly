import type { Step } from '../types.js';
import { REALISTIC, scenarioOf } from './_shared.js';

const topics = [
  'how the shell hands its line to Shelly',
  'what context goes along with a question',
  'how output is captured without touching the terminal',
  'why redraws are painted inline rather than in an alternate screen',
  'how permission prompts keep the user in control',
  'what happens when the terminal is resized mid-answer',
  'how long answers scroll while staying readable',
  'what gets remembered between sessions',
];

export const LONG_ANSWER = topics.map((topic, i) =>
  `${i === 0 ? '' : '\n'}**Part ${i + 1}.** This paragraph is about ${topic}. ` +
  'It is long enough to wrap across several lines of a normal terminal, which is the point: ' +
  'the renderer has to reflow streamed text, keep words whole where it can, and never leave stray characters ' +
  'behind when a line is redrawn. It goes on a little longer so that the whole answer is taller than the screen.\n',
).join('');

export const script: Step[] = [
  { type: 'message', text: LONG_ANSWER, ...REALISTIC },
];

export default scenarioOf('long-answer', script);
