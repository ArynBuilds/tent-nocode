import { SINGLE_IN, type FlowStepDef } from '../stepTypes.js';

/** Records one screen effect on the run's envelope; the page executes it after settle, values land as plain text. */
export const screenEffectStep: FlowStepDef = {
  kind: 'screen-effect',
  displayName: 'On the screen',
  blurb: 'tells the page that started this flow to go to a screen, show one sentence, open or close an overlay, or hand it a value',
  inputs: SINGLE_IN,
  outputs: ['out'],
  params: {
    effect: {
      type: 'enum', required: true,
      choices: ['go-to', 'message', 'overlay-open', 'overlay-close', 'answer'],
      help: 'what the screen should do',
    },
    target: { type: 'string', help: 'the screen for go-to, the overlay name, or the answer key' },
    value: { type: 'string', pill: true, help: 'the message text or the answer value - shows as plain text' },
  },
  guidance: 'Tells the PAGE THAT STARTED this flow what to do after it settles - only meaningful when a screen action started the flow. go-to needs the target screen, overlay-open/close the overlay name, message shows one sentence, answer hands a value back under a key the screen reads. Values land as plain text.',
  examples: [
    { title: 'confirm and move on', params: { effect: 'go-to', target: 'job-board' } },
    { title: 'hand the minted id back', params: { effect: 'answer', target: 'created-id', value: { from: 'step', step: 'save-rows', path: 'saved' } } },
  ],
  exec: { engine: 'screen-effect' },
};
