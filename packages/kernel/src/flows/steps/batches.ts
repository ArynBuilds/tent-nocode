import { SINGLE_IN, type FlowStepDef } from '../stepTypes.js';

// Loops rows in batches down `loop`; fires `done` once with everything that came back.
export const batchesStep: FlowStepDef = {
  kind: 'batches',
  displayName: 'Batches',
  blurb: 'runs the steps after it once per batch of rows',
  inputs: SINGLE_IN,
  outputs: ['loop', 'done'],
  params: {
    size: { type: 'number', required: true, help: 'how many rows each batch carries' },
  },
  guidance: 'Splits the incoming rows into batches of size and runs the steps wired off loop once per batch; done fires ONCE after the last batch with everything that came back. Use it to keep per-row work (a connection call, a tool) from firing hundreds of times in one burst.',
  examples: [
    { title: 'call an API 10 rows at a time', params: { size: 10 }, note: 'wire the connection step off the loop port; wire the after-work off done' },
  ],
  exec: { engine: 'batches' },
};
