import { SINGLE_IN, type FlowStepDef, type PureRunOutput } from '../stepTypes.js';

// Sorts keys so key order cannot fake a difference between identical rows.
function sortKeys(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(obj).sort()) out[k] = obj[k];
  return out;
}

// Keeps the first occurrence per key: the named field when set, else the whole row.
export const dedupeStep: FlowStepDef = {
  kind: 'dedupe',
  displayName: 'Dedupe',
  blurb: 'drops repeated rows, keeping the first',
  inputs: SINGLE_IN,
  outputs: ['out'],
  params: {
    by: { type: 'string', help: 'the field that decides sameness; empty = the whole row' },
  },
  guidance: 'Drops repeated rows, keeping the FIRST occurrence. by names the field that decides sameness; empty compares the whole row (key order cannot fake a difference). Sort first when which duplicate survives matters.',
  examples: [
    { title: 'one row per email', params: { by: 'email' } },
  ],
  exec: {
    pure: ({ params, inputs }): PureRunOutput => {
      const by = typeof params['by'] === 'string' ? params['by'] : '';
      const seen = new Set<string>();
      const out = (inputs['in'] ?? []).filter((item) => {
        const key = by !== '' ? String(item.json[by]) : JSON.stringify(sortKeys(item.json));
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      return { outputs: { out } };
    },
  },
};
