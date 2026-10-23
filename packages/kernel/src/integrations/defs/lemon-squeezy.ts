import type { IntegrationDefInput as IntegrationDef } from '../catalog.js';

// Lemon Squeezy checkout (websites only); server creates, page opens url, fulfillment via order_created webhook.
export const lemonSqueezy: IntegrationDef = {
  name: 'lemon-squeezy',
  version: 1,
  displayName: 'Lemon Squeezy',
  blurb: 'Sell through your own Lemon Squeezy store, taxes handled for you.',
  category: 'payments',
  surfaces: 'website',
  scope: 'builder',
  hosts: ['https://api.lemonsqueezy.com'],
  auth: {
    kind: 'bearer',
    secretName: 'LEMON_SQUEEZY_API_KEY',
    tokenHelp: 'In Lemon Squeezy under Settings, API, create an API key. Test Mode keys work only against your test-mode store.',
  },
  headers: {
    accept: 'application/vnd.api+json',
    'content-type': 'application/vnd.api+json',
  },
  endpoints: [
    {
      id: 'create-checkout',
      displayName: 'Start a checkout',
      method: 'POST',
      path: '/v1/checkouts',
      class: 'write',
      body: 'json',
      bodyConstants: {
        'data.type': 'checkouts',
        'data.relationships.store.data.type': 'stores',
        'data.relationships.variant.data.type': 'variants',
      },
      params: {
        store_id: { type: 'string', required: true, at: 'data.relationships.store.data.id', help: 'Your store ID, from the Lemon Squeezy dashboard address.' },
        variant_id: { type: 'string', required: true, at: 'data.relationships.variant.data.id', help: 'The variant ID of what is being bought.' },
      },
      picks: [
        { field: 'id', from: 'data.id' },
        { field: 'url', from: 'data.attributes.url' },
      ],
    },
  ],
  inside: {
    tables: [
      {
        name: 'checkouts',
        displayName: 'Checkouts',
        rowSchema: { id: 'string', url: 'string' },
        grain: 'app',
      },
    ],
    watchers: [
      { id: 'order-landed', displayName: 'An order lands', event: 'order_created' },
    ],
  },
  settings: [
    { id: 'store_id', label: 'Store', kind: 'text', help: 'Your Lemon Squeezy store ID.' },
    { id: 'variant_id', label: 'Product variant', kind: 'text', help: 'The default variant your checkout sells.' },
  ],
  fixtures: [
    {
      endpoint: 'create-checkout',
      params: { store_id: '1', variant_id: '1' },
      status: 201,
      response: {
        data: {
          type: 'checkouts',
          id: 'ac470bd4-7c41-46f9-b4d0-b5a04e2ec2d9',
          attributes: { url: 'https://my-store.lemonsqueezy.com/checkout/custom/ac470bd4-7c41-46f9-b4d0-b5a04e2ec2d9' },
        },
      },
    },
  ],
};
