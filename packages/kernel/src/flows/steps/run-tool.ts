import { SINGLE_IN, type FlowStepDef } from '../stepTypes.js';

/** Runs a Tool in the sealed executor; code touches data alone, network reach stays its own step. */
export const runToolStep: FlowStepDef = {
  kind: 'run-tool',
  displayName: 'Run a tool',
  blurb: 'runs one of your Tools (sealed, no network)',
  inputs: SINGLE_IN,
  outputs: ['out'],
  params: {
    tool: { type: 'string', required: true, help: 'the Tool to run' },
    inputs: { type: 'json', pill: true, help: 'input name → value (typed or a pill)' },
  },
  guidance: 'Runs one of the project Tools in the sealed executor - code touches data alone, no network (connection steps do reach). inputs maps the Tool input names to typed values or pills. The door to genuinely heavy compute the steps cannot express.',
  examples: [
    { title: 'score every row', params: { tool: 'lead-scorer', inputs: { rows: { from: 'step', step: 'get-rows', path: '' } } } },
  ],
  exec: { engine: 'run-tool' },
};
