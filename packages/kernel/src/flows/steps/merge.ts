import type { FlowStepDef } from '../stepTypes.js';

/** Waits for both inputs, then appends the two streams in slot order. */
export const mergeStep: FlowStepDef = {
  kind: 'merge',
  displayName: 'Merge',
  blurb: 'waits for both branches and joins their rows',
  inputs: { slots: ['a', 'b'], required: ['a', 'b'] },
  outputs: ['out'],
  params: {},
  guidance: 'Waits for BOTH inputs (slots a and b) and then appends the two streams in slot order - it joins branches, it does not match rows (Compare tables matches by key). Both slots must be wired or the step waits forever. Rejoin the two arms of an If here when they share a continuation.',
  examples: [
    { title: 'rejoin the branches of an If', params: {}, note: 'true arm -> slot a, false arm -> slot b' },
  ],
  exec: {
    pure: ({ inputs }) => ({ outputs: { out: [...(inputs['a'] ?? []), ...(inputs['b'] ?? [])] } }),
  },
};
