import { isPill } from '@nodeloom/core';
import { SINGLE_IN, type FlowStepDef } from '../stepTypes.js';

// Sets the declared fields per item (pills resolve against the item); keep-others defaults on.
export const editFieldsStep: FlowStepDef = {
  kind: 'edit-fields',
  displayName: 'Edit fields',
  blurb: 'sets or renames fields on every row',
  inputs: SINGLE_IN,
  outputs: ['out'],
  params: {
    fields: { type: 'json', required: true, pill: true, help: 'field name → value (typed or a pill)' },
    'keep-others': { type: 'boolean', help: 'off = only the set fields survive' },
  },
  guidance: 'Sets or overwrites fields on every row: fields maps field name to a typed value or a pill resolved per row. keep-others off keeps ONLY the set fields - the projection idiom before Save rows. This is the shape-fixer: add constants, copy values into new names, trim a row down to the landing columns.',
  examples: [
    { title: 'stamp a status and keep everything', params: { fields: { status: 'new' } } },
    { title: 'project to exactly two columns', params: { fields: { name: { from: 'step', step: 'get-rows', path: 'customer' }, total: { from: 'step', step: 'get-rows', path: 'price' } }, 'keep-others': false } },
  ],
  exec: {
    pure: ({ params, inputs, resolve }) => {
      const fields = (typeof params['fields'] === 'object' && params['fields'] !== null && !Array.isArray(params['fields'])
        ? params['fields'] : {}) as Record<string, unknown>;
      const keep = params['keep-others'] !== false;
      const out = (inputs['in'] ?? []).map((item) => {
        const next: Record<string, unknown> = keep ? { ...item.json } : {};
        for (const [k, v] of Object.entries(fields)) {
          next[k] = isPill(v) ? resolve(v, item) : v;
        }
        return { json: next };
      });
      return { outputs: { out } };
    },
  },
};
