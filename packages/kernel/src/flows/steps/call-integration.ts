import { SINGLE_IN, type FlowStepDef } from '../stepTypes.js';

// Fires one endpoint of a referenced Connection per row through the one dispatch door.
export const callIntegrationStep: FlowStepDef = {
  kind: 'call-integration',
  displayName: 'Send through a connection',
  blurb: 'fires one of a Connection\'s doors per row',
  inputs: SINGLE_IN,
  outputs: ['out'],
  params: {
    connection: { type: 'string', required: true, help: 'the Connection node (its row id)' },
    endpoint: { type: 'string', required: true, help: 'which door' },
    fields: { type: 'json', pill: true, help: 'field → value (typed or a pill); unset fields fill from the node settings at fire' },
  },
  guidance: 'Fires ONE endpoint of a placed Connection once per incoming row. connection is the Connection node row id (read it from the map), endpoint the door id from the service catalog. Fields left unset fill from the node settings at fire time; a disconnected Connection refuses at fire, never at authoring.',
  examples: [
    { title: 'a Slack message per row', params: { connection: '<connection-row-id>', endpoint: 'post-message', fields: { text: { from: 'step', step: 'make-text', path: 'text' } } } },
  ],
  exec: { engine: 'call-integration' },
};
