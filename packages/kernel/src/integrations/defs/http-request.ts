// Bridge to owner-run service; pinned origin, one encoded path step, cannot escape.
import type { IntegrationDefInput as IntegrationDef } from '../catalog.js';

export const httpRequest: IntegrationDef = {
  name: 'http-request',
  version: 1,
  displayName: 'HTTP request',
  blurb: 'Call a web service you run yourself - fetch data from it or send data to it.',
  category: 'bridge',
  surfaces: 'both',
  scope: 'builder',
  hosts: { ownerPinned: true },
  auth: { kind: 'none' },
  endpoints: [
    {
      id: 'fetch',
      displayName: 'Fetch data',
      method: 'GET',
      path: '/{path}',
      class: 'read',
      params: {
        path: {
          type: 'string',
          required: true,
          help: 'The place on your service to read from, like "status". One path step - it rides encoded and can never point outside your pinned service.',
        },
      },
    },
    {
      id: 'send',
      displayName: 'Send data',
      method: 'POST',
      path: '/{path}',
      class: 'send',
      params: {
        path: {
          type: 'string',
          required: true,
          help: 'The place on your service that receives, like "orders". One path step - it rides encoded and can never point outside your pinned service.',
        },
        payload: { type: 'string', required: true, help: 'What your service receives, as text or JSON.' },
      },
      body: 'json',
    },
  ],
  inside: { tables: [], watchers: [] },
  settings: [],
  fixtures: [
    { endpoint: 'fetch', params: { path: 'status' }, status: 200, response: { ok: true, status: 'green' } },
    { endpoint: 'send', params: { path: 'orders', payload: '{"hello":1}' }, status: 200, response: { ok: true } },
  ],
};
