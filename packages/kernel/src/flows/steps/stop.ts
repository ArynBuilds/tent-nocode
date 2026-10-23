import type { FlowStepDef, PureRunOutput } from '../stepTypes.js';

/** Fails the run with one plain sentence. */
export const stopStep: FlowStepDef = {
  kind: 'stop',
  displayName: 'Stop',
  blurb: 'stops the run and says why',
  inputs: { slots: ['in'], required: ['in'] },
  outputs: [],
  params: {
    message: { type: 'string', pill: true, help: 'the one sentence the record keeps' },
  },
  guidance: 'Fails the whole run with one plain sentence the record keeps. Wire it off the bad branch of an If as a guard: bad input stops loudly instead of flowing on.',
  examples: [
    { title: 'refuse an empty read', params: { message: 'nothing to process today' } },
  ],
  exec: {
    pure: ({ params, inputs, resolve }): PureRunOutput => {
      const raw = params['message'];
      const word = resolve(raw, (inputs['in'] ?? [])[0] ?? null);
      return { outputs: {}, error: typeof word === 'string' && word !== '' ? word : 'the flow stopped itself' };
    },
  },
};
