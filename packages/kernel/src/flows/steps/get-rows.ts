import type { FlowStepDef } from '../stepTypes.js';

// Reads a Table's latest rows as items.
export const getRowsStep: FlowStepDef = {
  kind: 'get-rows',
  displayName: 'Get rows',
  blurb: 'reads a Table\'s latest rows as items',
  inputs: { slots: ['in'], required: ['in'] },
  outputs: ['out'],
  params: {
    table: { type: 'string', required: true, help: 'which Table' },
    limit: { type: 'number', help: 'how many (latest first; empty = all, up to 5000)' },
  },
  guidance: 'Reads a Table fresh as one item per row (latest first, up to 5000). It still needs an incoming nudge to run - the trigger or screen action that starts the flow provides it. Filtering is Keep rows next; this step reads everything it can.',
  examples: [
    { title: 'read the whole jobs table', params: { table: 'jobs' } },
  ],
  exec: { engine: 'get-rows' },
};
