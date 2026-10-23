import type { FlowItem } from '@tent-nocode/core';
import { SINGLE_IN, type FlowStepDef, type PureRunOutput } from '../stepTypes.js';

/** Fans an array field out into one row per element; object elements spread, others land under the field name. */
export const oneRowPerStep: FlowStepDef = {
  kind: 'one-row-per',
  displayName: 'One row per...',
  blurb: 'fans an array field out into one row per element',
  inputs: SINGLE_IN,
  outputs: ['out'],
  params: {
    field: { type: 'string', required: true, help: 'the array field to fan out' },
    'keep-others': { type: 'boolean', help: 'keep the other fields on every row (on by default)' },
  },
  guidance: 'Fans an ARRAY field out into one row per element: object elements spread into columns, plain values land under the field name. keep-others on (the default) copies the other fields onto every born row. The inverse of Aggregate; the step after html take:all or an API answer holding a list.',
  examples: [
    { title: 'one row per fetched item', params: { field: 'items' }, note: '{ items: [{a:1},{a:2}] } -> two rows { a: 1 }, { a: 2 }' },
  ],
  exec: {
    pure: ({ params, inputs }): PureRunOutput => {
      const field = typeof params['field'] === 'string' ? params['field'] : '';
      const keep = params['keep-others'] !== false;
      const out: FlowItem[] = [];
      for (const item of inputs['in'] ?? []) {
        const value = field !== '' ? item.json[field] : undefined;
        if (!Array.isArray(value)) {
          out.push(item);
          continue;
        }
        const rest: Record<string, unknown> = { ...item.json };
        delete rest[field];
        const base = keep ? rest : {};
        for (const el of value) {
          const isPlainObject = typeof el === 'object' && el !== null && !Array.isArray(el);
          const row = isPlainObject ? { ...base, ...(el as Record<string, unknown>) } : { ...base, [field]: el };
          out.push({ json: row });
        }
      }
      return { outputs: { out } };
    },
  },
};
