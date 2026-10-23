import { SINGLE_IN, type FlowStepDef, type PureRunOutput } from '../stepTypes.js';

const CALCS = ['count', 'sum', 'min', 'max', 'average'] as const;
type Calc = (typeof CALCS)[number];

/** Runs one calc over rows; non-finite values skipped; sum of nothing is 0, others null. */
function runCalc(calc: Calc, rows: { json: Record<string, unknown> }[], field: string): number | null {
  if (calc === 'count') return rows.length;
  const nums = rows
    .map((r) => Number(r.json[field]))
    .filter((n) => Number.isFinite(n));
  if (calc === 'sum') return nums.reduce((a, b) => a + b, 0);
  if (nums.length === 0) return null;
  if (calc === 'min') return Math.min(...nums);
  if (calc === 'max') return Math.max(...nums);
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

/** Counts or totals the rows; a group-by field yields one output item per distinct value. */
export const summarizeStep: FlowStepDef = {
  kind: 'summarize',
  displayName: 'Summarize',
  blurb: 'counts or totals the rows, optionally per group',
  inputs: SINGLE_IN,
  outputs: ['out'],
  params: {
    calc: { type: 'enum', choices: [...CALCS], required: true, help: 'what to compute' },
    field: { type: 'string', help: 'the number field (count needs none)' },
    'group-by': { type: 'string', help: 'a field to group by; empty = one row for everything' },
  },
  guidance: 'The math step: count, sum, min, max, or average over the incoming rows. Empty group-by answers ONE row; a group-by field answers one row per distinct value, shaped { <group-field>, <calc> } - note the calc name IS the output field (rename-fields fits it to a table). count needs no field; the others read a number field.',
  examples: [
    { title: 'revenue per month', params: { calc: 'sum', field: 'price', 'group-by': 'month' }, note: 'answers rows like { month: "2026-08", sum: 115 }' },
  ],
  exec: {
    pure: ({ params, inputs }): PureRunOutput => {
      const items = inputs['in'] ?? [];
      const rawCalc = params['calc'];
      const calc: Calc =
        typeof rawCalc === 'string' && (CALCS as readonly string[]).includes(rawCalc) ? (rawCalc as Calc) : 'count';
      const field = typeof params['field'] === 'string' ? params['field'] : '';
      const groupBy = typeof params['group-by'] === 'string' ? params['group-by'] : '';

      if (calc !== 'count' && field === '') {
        return { outputs: {}, error: 'this calc needs a number field to read' };
      }

      if (groupBy === '') {
        return { outputs: { out: [{ json: { [calc]: runCalc(calc, items, field) } }] } };
      }

      const groups = new Map<string, { json: Record<string, unknown> }[]>();
      for (const item of items) {
        const key = String(item.json[groupBy]);
        const rows = groups.get(key);
        if (rows) rows.push(item);
        else groups.set(key, [item]);
      }
      const out = [...groups.entries()].map(([key, rows]) => ({
        json: { [groupBy]: key, [calc]: runCalc(calc, rows, field) },
      }));
      return { outputs: { out } };
    },
  },
};
