import { SINGLE_IN, type FlowStepDef, type PureRunOutput } from '../stepTypes.js';

/** Keeps only the first (or last) `count` rows; a missing or non-positive count passes items through. */
export const limitStep: FlowStepDef = {
  kind: 'limit',
  displayName: 'Limit',
  blurb: 'keeps only the first rows',
  inputs: SINGLE_IN,
  outputs: ['out'],
  params: {
    count: { type: 'number', required: true, help: 'how many rows to keep' },
    from: { type: 'enum', choices: ['start', 'end'], help: 'start is the default' },
  },
  guidance: 'Keeps only the first (or last) count rows. Sort first to make first/last mean something - Sort descending then Limit 5 is the top-five idiom.',
  examples: [
    { title: 'the top five by score', params: { count: 5 }, note: 'wire Sort (by score, descending) in front' },
  ],
  exec: {
    pure: ({ params, inputs }): PureRunOutput => {
      const items = inputs['in'] ?? [];
      const count = params['count'];
      if (typeof count !== 'number' || !Number.isFinite(count) || count <= 0) {
        return { outputs: { out: items } };
      }
      const kept = params['from'] === 'end' ? items.slice(-count) : items.slice(0, count);
      return { outputs: { out: kept } };
    },
  },
};
