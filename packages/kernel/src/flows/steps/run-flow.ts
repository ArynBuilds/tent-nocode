import { SINGLE_IN, type FlowStepDef } from '../stepTypes.js';

/** Runs another flow; the parent parks until the child settles and re-arms it. */
export const runFlowStep: FlowStepDef = {
  kind: 'run-flow',
  displayName: 'Run a flow',
  blurb: 'runs another flow and waits for its answer',
  inputs: SINGLE_IN,
  outputs: ['out'],
  params: {
    flow: { type: 'string', required: true, help: 'the flow to run (this project)' },
  },
  guidance: 'Runs another flow of this project by name and WAITS for it to settle; the incoming rows seed the child, the child answer comes back out. Compose big automations from small named flows instead of one long chain.',
  examples: [
    { title: 'delegate enrichment', params: { flow: 'enrich-contacts' } },
  ],
  exec: { engine: 'run-flow' },
};
