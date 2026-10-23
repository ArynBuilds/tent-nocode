import { SINGLE_IN, type FlowStepDef } from '../stepTypes.js';

/** Orders rows by one field; numeric compare when both sides parse as numbers, string compare otherwise. */

function sortValue(v: unknown): number | string {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return String(v ?? '');
}

export const sortStep: FlowStepDef = {
  kind: 'sort',
  displayName: 'Sort',
  blurb: 'orders the rows by a field',
  inputs: SINGLE_IN,
  outputs: ['out'],
  params: {
    by: { type: 'string', required: true, help: 'the field to sort by' },
    direction: {
      type: 'enum',
      choices: ['ascending', 'descending'],
      help: 'ascending is the default',
    },
  },
  guidance: 'Orders rows by one field: numeric compare when both sides parse as numbers, text compare otherwise; missing values sort last. Pair with Limit for top-N; sort before Dedupe to choose which duplicate survives.',
  examples: [
    { title: 'newest first', params: { by: 'created', direction: 'descending' } },
  ],
  exec: {
    pure: ({ params, inputs }) => {
      const items = inputs['in'] ?? [];
      const by = params['by'];
      if (typeof by !== 'string' || by === '') return { outputs: { out: items } };
      const descending = params['direction'] === 'descending';
      const sorted = [...items].sort((a, b) => {
        const av = a.json[by];
        const bv = b.json[by];
        const aMissing = av === undefined || av === null;
        const bMissing = bv === undefined || bv === null;
        // missing sorts last in ascending; the descending flip reverses it with the rest
        let cmp: number;
        if (aMissing || bMissing) {
          cmp = aMissing && bMissing ? 0 : aMissing ? 1 : -1;
        } else {
          const av2 = sortValue(av);
          const bv2 = sortValue(bv);
          cmp = typeof av2 === 'number' && typeof bv2 === 'number'
            ? av2 - bv2
            : String(av2).localeCompare(String(bv2));
        }
        return descending ? -cmp : cmp;
      });
      return { outputs: { out: sorted } };
    },
  },
};
