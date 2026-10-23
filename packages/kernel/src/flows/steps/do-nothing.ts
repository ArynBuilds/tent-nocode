import { SINGLE_IN, type FlowStepDef, type PureRunOutput } from '../stepTypes.js';

// Passes every row through untouched.
export const doNothingStep: FlowStepDef = {
  kind: 'do-nothing',
  displayName: 'Do nothing',
  blurb: 'passes every row through untouched',
  inputs: SINGLE_IN,
  outputs: ['out'],
  params: {},
  guidance: 'Passes every row through untouched - a junction point. Use it to fan several branches into one continuation, or as a named landmark in a long chain.',
  examples: [
    { title: 'join two branches into one continuation', params: {}, note: 'wire both branches in, wire the rest of the flow out once' },
  ],
  exec: {
    pure: ({ inputs }): PureRunOutput => {
      return { outputs: { out: inputs['in'] ?? [] } };
    },
  },
};
