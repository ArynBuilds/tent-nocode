import { SINGLE_IN, type FlowStepDef } from '../stepTypes.js';

// Collects one field from every input row into a single array field on one output item.
export const aggregateStep: FlowStepDef = {
  kind: 'aggregate',
  displayName: 'Aggregate',
  blurb: 'collects a field from every row into one row',
  inputs: SINGLE_IN,
  outputs: ['out'],
  params: {
    field: { type: 'string', required: true, help: 'the field to collect' },
    as: { type: 'string', help: 'the array field on the one row (defaults to the field name)' },
  },
  guidance: 'Collects ONE field from every incoming row into a single array field on ONE output row - it never does math (Summarize counts and totals). Use it to hand a whole list to one downstream step, e.g. before Make text or Run a tool.',
  examples: [
    { title: 'gather every email into one row', params: { field: 'email', as: 'emails' }, note: '10 rows in -> 1 row out: { emails: [ ...10 values ] }' },
  ],
  exec: {
    pure: ({ params, inputs }) => {
      const items = inputs['in'] ?? [];
      const field = typeof params['field'] === 'string' ? params['field'] : '';
      if (!field) return { outputs: { out: items } };
      const asField = typeof params['as'] === 'string' && params['as'] !== '' ? params['as'] : field;
      const collected: unknown[] = [];
      for (const item of items) {
        if (field in item.json) collected.push(item.json[field]);
      }
      return { outputs: { out: [{ json: { [asField]: collected } }] } };
    },
  },
};
