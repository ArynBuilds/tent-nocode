import type { IntegrationDefInput as IntegrationDef } from '../catalog.js';

// Paddle integration def: server creates a transaction, the client opens checkout with the returned id.
// Live checkouts open only on Paddle-approved domains.
export const paddle: IntegrationDef = {
  name: 'paddle',
  version: 1,
  displayName: 'Paddle',
  blurb: 'Sell through your own Paddle account, taxes handled by Paddle.',
  category: 'payments',
  surfaces: 'website',
  scope: 'builder',
  hosts: ['https://api.paddle.com', 'https://sandbox-api.paddle.com'],
  auth: {
    kind: 'bearer',
    secretName: 'PADDLE_API_KEY',
    tokenHelp: 'In Paddle under Developer tools, Authentication, create an API key (pdl_live_apikey_, or pdl_sdbx_apikey_ while testing). The client-side token rides the page, never here.',
  },
  endpoints: [
    {
      id: 'create-transaction',
      displayName: 'Start a purchase',
      method: 'POST',
      path: '/transactions',
      class: 'write',
      body: 'json',
      params: {
        price_id: { type: 'string', required: true, at: 'items.0.price_id', help: 'The Price ID of what is being bought, from your Paddle catalog (pri_...).' },
        quantity: { type: 'number', required: true, at: 'items.0.quantity', help: 'How many.' },
      },
      picks: [
        { field: 'id', from: 'data.id' },
        { field: 'status', from: 'data.status' },
        { field: 'checkout_url', from: 'data.checkout.url' },
      ],
    },
  ],
  inside: {
    tables: [
      {
        name: 'transactions',
        displayName: 'Purchases',
        rowSchema: { id: 'string', status: 'string' },
        grain: 'app',
      },
    ],
    watchers: [
      { id: 'purchase-landed', displayName: 'A purchase completes', event: 'transaction.completed' },
    ],
  },
  settings: [
    { id: 'price_id', label: 'Price', kind: 'text', help: 'The default Price ID your checkout sells (pri_...).' },
  ],
  fixtures: [
    {
      endpoint: 'create-transaction',
      params: { price_id: 'pri_01gsz8x8sawmvhz1pv30nge1ke', quantity: 1 },
      status: 201,
      response: {
        data: {
          id: 'txn_01h04vsc0qhwtsbsxh3422wjs4',
          status: 'draft',
          checkout: { url: 'https://example-store.paddle.com/checkout?_ptxn=txn_01h04vsc0qhwtsbsxh3422wjs4' },
        },
      },
    },
  ],
};
