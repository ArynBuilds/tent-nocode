import type { IntegrationDefInput as IntegrationDef } from '../catalog.js';

// eBay seller-order reads; no fromArray because element fields are camelCase, so the first order lands per pull through snake-named picks.
export const ebay: IntegrationDef = {
  name: 'ebay',
  version: 1,
  displayName: 'eBay',
  blurb: 'Read the orders from your own eBay seller account into your app.',
  category: 'e-commerce',
  availability: 'upcoming',
  surfaces: 'both',
  scope: 'builder',
  hosts: ['https://api.ebay.com'],
  auth: {
    kind: 'oauth',
    authUrl: 'https://auth.ebay.com/oauth2/authorize',
    tokenUrl: 'https://api.ebay.com/identity/v1/oauth2/token',
    scopes: ['https://api.ebay.com/oauth/api_scope/sell.fulfillment.readonly'],
    clientEnv: 'EBAY',
    tokenHelp: 'Click Sign in to eBay and approve access to your selling account - there is no key to paste.',
  },
  endpoints: [
    {
      id: 'get-orders',
      displayName: 'Read your orders',
      method: 'GET',
      path: '/sell/fulfillment/v1/order',
      class: 'read',
      params: {
        filter: {
          type: 'string',
          help: 'Narrow the pull, like: creationdate:[2026-07-01T00:00:00.000Z..] - leave empty for the most recent orders.',
        },
        limit: {
          type: 'number',
          help: 'How many orders per pull, up to 200. eBay defaults to 50.',
        },
        offset: {
          type: 'number',
          help: 'How many orders to skip before the first returned one.',
        },
        order_ids: {
          type: 'string',
          wire: 'orderIds',
          help: 'Up to 50 order IDs, comma separated - when set, the other filters are ignored.',
        },
      },
      picks: [
        { field: 'order_id', from: 'orders.0.orderId' },
        { field: 'creation_date', from: 'orders.0.creationDate' },
        { field: 'fulfillment_status', from: 'orders.0.orderFulfillmentStatus' },
        { field: 'payment_status', from: 'orders.0.orderPaymentStatus' },
        { field: 'buyer', from: 'orders.0.buyer.username' },
        { field: 'total', from: 'orders.0.pricingSummary.total.value' },
        { field: 'currency', from: 'orders.0.pricingSummary.total.currency' },
        { field: 'count', from: 'total' },
      ],
    },
    {
      id: 'get-order',
      displayName: 'Look up one order',
      method: 'GET',
      path: '/sell/fulfillment/v1/order/{order_id}',
      class: 'read',
      params: {
        order_id: {
          type: 'string',
          required: true,
          help: 'The order ID, like 11-06584-25861 - shown in Seller Hub and returned by the order read.',
        },
      },
      picks: [
        { field: 'order_id', from: 'orderId' },
        { field: 'creation_date', from: 'creationDate' },
        { field: 'fulfillment_status', from: 'orderFulfillmentStatus' },
        { field: 'payment_status', from: 'orderPaymentStatus' },
        { field: 'buyer', from: 'buyer.username' },
        { field: 'total', from: 'pricingSummary.total.value' },
        { field: 'currency', from: 'pricingSummary.total.currency' },
      ],
    },
  ],
  inside: {
    // Order mirror pulls once per app; one row per pull from the picks.
    tables: [
      {
        name: 'orders',
        displayName: 'Orders',
        rowSchema: {
          'order-id': 'string',
          'creation-date': 'string',
          'fulfillment-status': 'string',
          'payment-status': 'string',
          buyer: 'string',
          total: 'number',
          currency: 'string',
        },
        grain: 'app',
      },
    ],
    watchers: [],
  },
  // Order read fires hourly; every param is optional, so the mirror works from the first sync.
  sync: { endpoint: 'get-orders', everyMinutes: 60 },
  settings: [
    {
      id: 'filter',
      label: 'Order filter',
      kind: 'text',
      help: 'What the mirror pulls on every sync, like: creationdate:[2026-07-01T00:00:00.000Z..] - empty pulls the most recent orders.',
    },
    {
      id: 'limit',
      label: 'Orders per pull',
      kind: 'number',
      help: 'How many orders each sync pulls, up to 200. eBay defaults to 50.',
    },
  ],
  fixtures: [
    {
      endpoint: 'get-orders',
      params: { filter: 'creationdate:[2026-07-01T00:00:00.000Z..]', limit: 50 },
      status: 200,
      response: {
        href: 'https://api.ebay.com/sell/fulfillment/v1/order?filter=creationdate:%5B2026-07-01T00:00:00.000Z..%5D&limit=50&offset=0',
        total: 1,
        limit: 50,
        offset: 0,
        orders: [
          {
            orderId: '11-06584-25861',
            legacyOrderId: '110652808049-28551482013',
            creationDate: '2026-07-30T18:42:52.159Z',
            lastModifiedDate: '2026-07-30T19:01:10.000Z',
            orderFulfillmentStatus: 'NOT_STARTED',
            orderPaymentStatus: 'PAID',
            sellerId: 'seller_10',
            buyer: { username: 'buyer_10' },
            cancelStatus: { cancelState: 'NONE_REQUESTED', cancelRequests: [] },
            pricingSummary: {
              priceSubtotal: { value: '84.99', currency: 'USD' },
              deliveryCost: { value: '4.99', currency: 'USD' },
              total: { value: '89.98', currency: 'USD' },
            },
            lineItems: [
              {
                lineItemId: '10005510791522',
                legacyItemId: '110652808049',
                title: 'Vintage film camera',
                sku: 'CAM-VIN-01',
                quantity: 1,
                lineItemCost: { value: '84.99', currency: 'USD' },
                soldFormat: 'FIXED_PRICE',
                listingMarketplaceId: 'EBAY_US',
              },
            ],
          },
        ],
      },
    },
    {
      endpoint: 'get-order',
      params: { order_id: '11-06584-25861' },
      status: 200,
      response: {
        orderId: '11-06584-25861',
        legacyOrderId: '110652808049-28551482013',
        creationDate: '2026-07-30T18:42:52.159Z',
        lastModifiedDate: '2026-07-30T19:01:10.000Z',
        orderFulfillmentStatus: 'NOT_STARTED',
        orderPaymentStatus: 'PAID',
        sellerId: 'seller_10',
        buyer: { username: 'buyer_10' },
        pricingSummary: {
          priceSubtotal: { value: '84.99', currency: 'USD' },
          deliveryCost: { value: '4.99', currency: 'USD' },
          total: { value: '89.98', currency: 'USD' },
        },
        lineItems: [
          {
            lineItemId: '10005510791522',
            legacyItemId: '110652808049',
            title: 'Vintage film camera',
            sku: 'CAM-VIN-01',
            quantity: 1,
            lineItemCost: { value: '84.99', currency: 'USD' },
          },
        ],
      },
    },
  ],
};
