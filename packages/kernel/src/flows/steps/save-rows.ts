import { SINGLE_IN, type FlowStepDef } from '../stepTypes.js';

/** Lands every item as a Table row through the standing data door. */
export const saveRowsStep: FlowStepDef = {
  kind: 'save-rows',
  displayName: 'Save rows',
  blurb: 'lands every item as a Table row',
  inputs: SINGLE_IN,
  outputs: ['out'],
  params: {
    table: { type: 'string', required: true, help: 'which Table' },
  },
  guidance: 'Lands every incoming item as a row of the named Table - the ONE way flow results become visible to screens (bindings are live; anything showing this table updates by itself). Row fields must fit the table schema; a fully refused append FAILS the run naming the reason. Shape first: Edit fields or Rename fields make the columns fit.',
  examples: [
    { title: 'land the monthly totals', params: { table: 'monthly-revenue' }, note: 'rows arriving as { month, amount } - renamed to fit the schema upstream' },
  ],
  exec: { engine: 'save-rows' },
};
