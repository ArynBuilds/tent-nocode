import type { IntegrationDefInput as IntegrationDef } from '../catalog.js';

// Etsy seller-order reads; Money fields are nested objects the by-name fan-out cannot flatten, so no money column is declared.
export const etsy: IntegrationDef = {
  name: 'etsy',
  version: 1,
  displayName: 'Etsy',
  blurb: 'Bring your Etsy shop orders into your app straight from your own seller account.',
  category: 'e-commerce',
  surfaces: 'both',
  scope: 'builder',
  // Upcoming until the Etsy app is registered.
  availability: 'upcoming',
  hosts: ['https://api.etsy.com'],
  auth: {
    kind: 'oauth',
    authUrl: 'https://www.etsy.com/oauth/connect',
    tokenUrl: 'https://api.etsy.com/v3/public/oauth/token',
    scopes: ['transactions_r', 'shops_r'],
    clientEnv: 'ETSY',
    tokenHelp: 'Sign in with your Etsy account when connecting - Nodeloom holds the keys, nothing to paste.',
  },
  endpoints: [
    {
      id: 'get-receipts',
      displayName: 'Read your shop orders',
      method: 'GET',
      path: '/v3/application/shops/{shop_id}/receipts',
      class: 'read',
      params: {
        shop_id: {
          type: 'string',
          required: true,
          help: 'Your numeric Etsy shop id - fill it once in the Shop setting.',
        },
        limit: {
          type: 'number',
          help: 'Orders per pull, 1 to 100. Etsy answers 25 when unset.',
        },
        was_paid: {
          type: 'boolean',
          help: 'Only orders the buyer has paid for (or only unpaid ones when off).',
        },
        was_shipped: {
          type: 'boolean',
          help: 'Only orders already shipped (or only unshipped ones when off).',
        },
      },
      picks: [{ field: 'count', from: 'count' }],
    },
  ],
  inside: {
    // One row per receipt, fan-out over the results array.
    tables: [
      {
        name: 'orders',
        displayName: 'Orders',
        rowSchema: {
          'receipt-id': 'number',
          name: 'string',
          status: 'string',
          'is-paid': 'boolean',
          'is-shipped': 'boolean',
          'created-timestamp': 'number',
        },
        grain: 'app',
        fromArray: 'results',
      },
    ],
    watchers: [],
  },
  settings: [
    // Matches the shop_id path param; set once, every call fills it.
    {
      id: 'shop_id',
      label: 'Shop',
      kind: 'text',
      help: 'Your numeric Etsy shop id, shown in your shop dashboard URL.',
    },
  ],
  // Read fires every 30 minutes; shop_id fills from the setting.
  sync: { endpoint: 'get-receipts', everyMinutes: 30 },
  fixtures: [
    {
      endpoint: 'get-receipts',
      params: { shop_id: '12345678', limit: 25 },
      status: 200,
      response: {
        count: 2,
        results: [
          {
            receipt_id: 3100210999,
            receipt_type: 0,
            seller_user_id: 345678901,
            buyer_user_id: 987654321,
            name: 'James Buyer',
            first_line: '123 Main St',
            city: 'Brooklyn',
            state: 'NY',
            zip: '11201',
            status: 'paid',
            is_paid: true,
            is_shipped: false,
            create_timestamp: 1665695529,
            created_timestamp: 1665695529,
            update_timestamp: 1665695529,
            updated_timestamp: 1665695529,
            grandtotal: { amount: 3524, divisor: 100, currency_code: 'USD' },
            subtotal: { amount: 3000, divisor: 100, currency_code: 'USD' },
            total_price: { amount: 3000, divisor: 100, currency_code: 'USD' },
            total_shipping_cost: { amount: 524, divisor: 100, currency_code: 'USD' },
          },
          {
            receipt_id: 3100210998,
            receipt_type: 0,
            seller_user_id: 345678901,
            buyer_user_id: 987654322,
            name: 'Ana Compradora',
            first_line: '77 Elm Ave',
            city: 'Portland',
            state: 'OR',
            zip: '97205',
            status: 'completed',
            is_paid: true,
            is_shipped: true,
            create_timestamp: 1665600000,
            created_timestamp: 1665600000,
            update_timestamp: 1665700000,
            updated_timestamp: 1665700000,
            grandtotal: { amount: 1850, divisor: 100, currency_code: 'USD' },
            subtotal: { amount: 1500, divisor: 100, currency_code: 'USD' },
            total_price: { amount: 1500, divisor: 100, currency_code: 'USD' },
            total_shipping_cost: { amount: 350, divisor: 100, currency_code: 'USD' },
          },
        ],
      },
    },
  ],
};
