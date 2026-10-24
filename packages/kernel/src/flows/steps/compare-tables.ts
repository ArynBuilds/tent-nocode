import type { FlowItem } from '@nodeloom/core';
import type { FlowStepDef, PureRunOutput } from '../stepTypes.js';

// Matches two streams by a key field and splits rows onto in-both / only-a / only-b.
export const compareTablesStep: FlowStepDef = {
  kind: 'compare-tables',
  displayName: 'Compare tables',
  blurb: 'matches two streams by a key and splits them',
  inputs: { slots: ['a', 'b'], required: ['a', 'b'] },
  outputs: ['in-both', 'only-a', 'only-b'],
  params: {
    by: { type: 'string', required: true, help: 'the key field both sides share' },
  },
  guidance: 'Takes TWO input streams (slots a and b - both must be wired or the step waits forever) and matches rows by the shared key field. Three outputs: in-both (a rows whose key exists in b), only-a, only-b. The classic sync shape: only-a = new things to add, only-b = things gone.',
  examples: [
    { title: 'diff fetched rows against the table', params: { by: 'id' }, note: 'wire the fresh feed to slot a, Get rows to slot b; save only-a' },
  ],
  exec: {
    pure: ({ params, inputs }): PureRunOutput => {
      const a = inputs['a'] ?? [];
      const b = inputs['b'] ?? [];
      const by = params['by'];
      if (typeof by !== 'string' || by === '') {
        return { outputs: { 'in-both': [], 'only-a': a, 'only-b': b } };
      }
      const key = (item: FlowItem) => String(item.json[by] ?? '');
      const bKeys = new Set(b.map(key));
      const aKeys = new Set(a.map(key));
      const inBoth: FlowItem[] = [];
      const onlyA: FlowItem[] = [];
      for (const item of a) {
        (bKeys.has(key(item)) ? inBoth : onlyA).push(item);
      }
      const onlyB = b.filter((item) => !aKeys.has(key(item)));
      return { outputs: { 'in-both': inBoth, 'only-a': onlyA, 'only-b': onlyB } };
    },
  },
};
