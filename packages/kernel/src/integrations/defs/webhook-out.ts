// Generic outbound webhook; the owner supplies the https origin, which snapshots into the connection row.
import type { IntegrationDefInput as IntegrationDef } from '../catalog.js';

export const webhookOut: IntegrationDef = {
  name: 'webhook-out',
  version: 1,
  displayName: 'Webhook',
  blurb: 'Send data from your app to a service you run yourself.',
  category: 'bridge',
  surfaces: 'both',
  scope: 'builder',
  hosts: { ownerPinned: true },
  auth: { kind: 'none' },
  endpoints: [
    {
      id: 'send',
      displayName: 'Send data',
      method: 'POST',
      path: '/',
      class: 'send',
      params: {
        payload: { type: 'string', required: true, help: 'What your service receives, as text or JSON.' },
      },
      body: 'json',
    },
  ],
  inside: { tables: [], watchers: [] },
  settings: [],
  fixtures: [{ endpoint: 'send', params: { payload: '{"hello":1}' }, status: 200, response: { ok: true } }],
};
