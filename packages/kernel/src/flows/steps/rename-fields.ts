import { SINGLE_IN, type FlowStepDef } from '../stepTypes.js';

/** Renames fields on every row; a missing field or an empty map does nothing. */
export const renameFieldsStep: FlowStepDef = {
  kind: 'rename-fields',
  displayName: 'Rename fields',
  blurb: 'renames fields on every row',
  inputs: SINGLE_IN,
  outputs: ['out'],
  params: {
    renames: { type: 'json', required: true, help: 'old name → new name' },
  },
  guidance: 'Renames fields on every row: the map is old name to new name; missing fields no-op quietly. The last-mile fit before Save rows when computed field names (day, sum) must land in the table columns (month, amount).',
  examples: [
    { title: 'fit summarize output to the table', params: { renames: { day: 'month', sum: 'amount' } } },
  ],
  exec: {
    pure: ({ params, inputs }) => {
      const items = inputs['in'] ?? [];
      const renames = (typeof params['renames'] === 'object' && params['renames'] !== null && !Array.isArray(params['renames'])
        ? params['renames'] : {}) as Record<string, unknown>;
      const entries = Object.entries(renames).filter(([, v]) => typeof v === 'string') as [string, string][];
      if (entries.length === 0) return { outputs: { out: items } };
      const out = items.map((item) => {
        const next: Record<string, unknown> = { ...item.json };
        for (const [oldName, newName] of entries) {
          if (Object.prototype.hasOwnProperty.call(next, oldName)) {
            next[newName] = next[oldName];
            delete next[oldName];
          }
        }
        return { json: next };
      });
      return { outputs: { out } };
    },
  },
};
