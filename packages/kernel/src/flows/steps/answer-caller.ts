import { SINGLE_IN, type FlowStepDef } from '../stepTypes.js';

// Records a plain-text answer for the webhook caller; the first answer-caller step wins.
export const answerCallerStep: FlowStepDef = {
  kind: 'answer-caller',
  displayName: 'Answer the caller',
  blurb: 'answers the webhook call that started this flow with one plain value - the caller waits a few seconds at most, then gets the standing acknowledgement',
  inputs: SINGLE_IN,
  outputs: ['out'],
  params: {
    value: { type: 'string', required: true, pill: true, help: 'what the caller hears back - plain text' },
    status: { type: 'enum', choices: ['200', '201'], help: 'the HTTP status the caller gets - 200 unless a creation asks for 201' },
  },
  guidance: 'Answers the webhook call that STARTED this flow - only meaningful when a webhook trigger starts the flow. The first Answer the caller step to run wins; later ones land nothing. The caller waits a few seconds at most, so put this early and let slow work continue after it.',
  examples: [
    { title: 'acknowledge with the minted id', params: { value: { from: 'step', step: 'save-rows', path: 'saved' }, status: '201' }, note: 'the value param takes a pill from an earlier step' },
  ],
  exec: { engine: 'answer-caller' },
};
