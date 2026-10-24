import { conditionSchema, type FlowItem } from '@nodeloom/core';
import { SINGLE_IN, type FlowStepDef, type PureRunOutput } from '../stepTypes.js';

// Splits items disjoint onto true/false outputs via the shared condition grammar.
export const ifStep: FlowStepDef = {
  kind: 'if',
  displayName: 'If',
  blurb: 'sends each row down the true or the false branch',
  inputs: SINGLE_IN,
  outputs: ['true', 'false'],
  params: {
    condition: { type: 'condition', required: true, help: 'the check each row takes' },
  },
  guidance: 'Sends each row down exactly one of two ports: true or false. The condition uses the shared grammar (is, contains, is more than, is empty, is yes, is before, ...). Wire BOTH ports when both paths matter; an unwired port drops its rows quietly. Keep rows is the one-sided version.',
  examples: [
    { title: 'route rush jobs', params: { condition: { combine: 'and', rules: [{ left: { from: 'step', step: 'get-rows', path: 'rush' }, op: 'is-true' }] } }, note: 'true -> the urgent branch, false -> the normal one' },
  ],
  exec: {
    pure: ({ params, inputs, evalCondition }): PureRunOutput => {
      const parsed = conditionSchema.safeParse(params['condition']);
      if (!parsed.success) return { outputs: {}, error: 'the If step needs its condition set' };
      const yes: FlowItem[] = [];
      const no: FlowItem[] = [];
      for (const item of inputs['in'] ?? []) {
        (evalCondition(parsed.data, item) ? yes : no).push(item);
      }
      return { outputs: { true: yes, false: no } };
    },
  },
};
