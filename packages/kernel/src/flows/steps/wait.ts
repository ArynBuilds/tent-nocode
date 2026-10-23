import { SINGLE_IN, type FlowStepDef } from '../stepTypes.js';

/** Parks the run in the row (status waiting + wait_till); the sweeper resumes it. */
export const waitStep: FlowStepDef = {
  kind: 'wait',
  displayName: 'Wait',
  blurb: 'pauses the run, then carries on',
  inputs: SINGLE_IN,
  outputs: ['out'],
  params: {
    minutes: { type: 'number', help: 'how long (or set an exact moment below)' },
    until: { type: 'string', pill: true, help: 'an exact moment (ISO) — wins over minutes' },
  },
  guidance: 'Parks the run and resumes later: minutes from now, or until an exact ISO moment (until wins). The run survives restarts while parked. Space out polite API usage or hold a follow-up for tomorrow.',
  examples: [
    { title: 'follow up in a day', params: { minutes: 1440 } },
  ],
  exec: { engine: 'wait' },
};
