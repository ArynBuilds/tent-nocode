import { conditionSchema } from '@nodeloom/core';
import { SINGLE_IN, type FlowStepDef, type PureRunOutput } from '../stepTypes.js';

/** Keeps only the rows that pass the condition; failing rows leave quietly. */
export const keepRowsStep: FlowStepDef = {
  kind: 'keep-rows',
  displayName: 'Keep rows',
  blurb: 'keeps only the rows that pass the check',
  inputs: SINGLE_IN,
  outputs: ['out'],
  params: {
    condition: { type: 'condition', required: true, help: 'rows that pass stay' },
  },
  guidance: 'Keeps only the rows that pass the check; failing rows leave QUIETLY - there is no second output (If gives you both branches). The standard narrowing step right after Get rows.',
  examples: [
    { title: 'only the finished ones', params: { condition: { combine: 'and', rules: [{ left: { from: 'step', step: 'get-rows', path: 'status' }, op: 'equals', right: 'done' }] } } },
  ],
  exec: {
    pure: ({ params, inputs, evalCondition }): PureRunOutput => {
      const parsed = conditionSchema.safeParse(params['condition']);
      if (!parsed.success) return { outputs: {}, error: 'the Keep rows step needs its condition set' };
      return { outputs: { out: (inputs['in'] ?? []).filter((item) => evalCondition(parsed.data, item)) } };
    },
  },
};
