import type { IntegrationDefInput as IntegrationDef } from '../catalog.js';

// Printify print-on-demand fulfillment def.
export const printify: IntegrationDef = {
  name: 'printify',
  version: 1,
  displayName: 'Printify',
  blurb: 'Read and place print-on-demand orders through your own Printify shop.',
  category: 'fulfillment',
  surfaces: 'both',
  scope: 'builder',
  hosts: ['https://api.printify.com'],
  auth: {
    kind: 'bearer',
    secretName: 'PRINTIFY_API_TOKEN',
    tokenHelp: 'Generate a Personal Access Token under Connections in your Printify account settings.',
  },
  // Printify requires a User-Agent header on every request.
  headers: { 'user-agent': 'nodeloom' },
  endpoints: [
    {
      id: 'list-orders',
      displayName: 'Read shop orders',
      method: 'GET',
      path: '/v1/shops/{shop_id}/orders.json',
      class: 'read',
      params: {
        shop_id: { type: 'string', required: true, help: 'Your Printify shop id - fill it once in the Shop setting.' },
        page: { type: 'number', help: 'Which page of orders to read.' },
        limit: { type: 'number', help: 'Orders per page, up to 10.' },
        status: { type: 'string', help: 'Only orders in this state, like fulfilled or in-production.' },
        sku: { type: 'string', help: 'Only orders containing this product SKU.' },
      },
      picks: [
        { field: 'id', from: 'data.0.id' },
        { field: 'status', from: 'data.0.status' },
        { field: 'total_price', from: 'data.0.total_price' },
      ],
    },
    {
      id: 'create-order',
      displayName: 'Create an order',
      method: 'POST',
      path: '/v1/shops/{shop_id}/orders.json',
      class: 'write',
      body: 'json',
      params: {
        shop_id: { type: 'string', required: true, help: 'Your Printify shop id - fill it once in the Shop setting.' },
        product_id: { type: 'string', required: true, at: 'line_items.0.product_id', help: 'The Printify product to print.' },
        variant_id: { type: 'number', required: true, at: 'line_items.0.variant_id', help: 'Which size and color variant of the product.' },
        quantity: { type: 'number', required: true, at: 'line_items.0.quantity', help: 'How many to print.' },
        external_id: { type: 'string', help: 'Your own reference for this order.' },
        label: { type: 'string', help: 'A short label shown on the order in Printify.' },
        shipping_method: { type: 'number', help: 'The Printify shipping method number, like 1 for standard.' },
        first_name: { type: 'string', required: true, at: 'address_to.first_name' },
        last_name: { type: 'string', required: true, at: 'address_to.last_name' },
        address1: { type: 'string', required: true, at: 'address_to.address1', help: 'Street address.' },
        address2: { type: 'string', at: 'address_to.address2' },
        city: { type: 'string', required: true, at: 'address_to.city' },
        region: { type: 'string', at: 'address_to.region', help: 'State or province, where the country needs one.' },
        zip: { type: 'string', required: true, at: 'address_to.zip' },
        country: { type: 'string', required: true, at: 'address_to.country', help: 'Two-letter country code, like US.' },
        email: { type: 'string', required: true, at: 'address_to.email', help: 'Where shipping updates for the recipient go.' },
        phone: { type: 'string', at: 'address_to.phone' },
      },
      picks: [{ field: 'id', from: 'id' }],
    },
  ],
  inside: {
    // Orders table: rows fill from create-order params and list-orders picks.
    tables: [
      {
        name: 'orders',
        displayName: 'Orders',
        rowSchema: {
          'id': 'string',
          'product-id': 'string',
          'variant-id': 'number',
          'quantity': 'number',
          'status': 'string',
          'total-price': 'number',
        },
        grain: 'app',
      },
    ],
    watchers: [],
  },
  settings: [
    // This id fills the shop_id path param on both endpoints.
    { id: 'shop_id', label: 'Shop', kind: 'text', help: 'Your Printify shop id, shown in your Printify dashboard.' },
  ],
  fixtures: [
    {
      endpoint: 'list-orders',
      params: { shop_id: '815256', limit: 10, page: 1 },
      status: 200,
      response: {
        current_page: 1,
        data: [
          {
            id: '5a6e03bd2f7d8055768923c8',
            app_order_id: '215014.44',
            status: 'fulfilled',
            total_price: 2200,
            total_shipping: 400,
            total_tax: 0,
            created_at: '2017-04-18 13:24:28+00:00',
          },
        ],
        total: 22,
        last_page: 22,
      },
    },
    {
      endpoint: 'create-order',
      params: {
        shop_id: '815256',
        product_id: '5bfd0b66a342bcc9b5563216',
        variant_id: 17887,
        quantity: 1,
        external_id: '2750e210-39bb-11e9-a503-452618153e4a',
        label: '00012',
        shipping_method: 1,
        first_name: 'Jane',
        last_name: 'Smith',
        address1: 'ExampleBaan 121',
        city: 'Retie',
        zip: '2470',
        country: 'BE',
        email: 'example@msn.com',
        phone: '0574 69 21 90',
      },
      status: 200,
      response: { id: '5a96f649b2439217d070f507' },
    },
  ],
};
