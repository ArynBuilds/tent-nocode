import type { IntegrationDefInput as IntegrationDef } from '../catalog.js';

// PayPal integration def: upcoming - needs a client-credentials token mint the auth grammar does not carry yet.
export const paypal: IntegrationDef = {
  name: 'paypal',
  version: 1,
  displayName: 'PayPal',
  blurb: 'Take PayPal payments on your website through your own PayPal business account.',
  category: 'payments',
  surfaces: 'website',
  scope: 'builder',
  availability: 'upcoming',
  hosts: ['https://api-m.paypal.com', 'https://api-m.sandbox.paypal.com'],
  auth: {
    kind: 'bearer',
    secretName: 'PAYPAL_ACCESS_TOKEN',
    tokenHelp: 'PayPal connects with your business app credentials once its lane opens - nothing to paste yet.',
  },
  endpoints: [
    {
      id: 'create-order',
      displayName: 'Start a payment',
      method: 'POST',
      path: '/v2/checkout/orders',
      class: 'write',
      body: 'json',
      bodyConstants: { intent: 'CAPTURE' },
      params: {
        amount: { type: 'string', required: true, at: 'purchase_units.0.amount.value', help: 'The amount, like 100.00.' },
        currency: { type: 'string', required: true, at: 'purchase_units.0.amount.currency_code', help: 'Three-letter currency, like USD.' },
      },
      picks: [
        { field: 'id', from: 'id' },
        { field: 'status', from: 'status' },
      ],
    },
    {
      id: 'capture-order',
      displayName: 'Take the approved payment',
      method: 'POST',
      path: '/v2/checkout/orders/{order_id}/capture',
      class: 'write',
      params: {
        order_id: { type: 'string', required: true, help: 'The order the buyer just approved.' },
      },
      picks: [
        { field: 'id', from: 'id' },
        { field: 'status', from: 'status' },
      ],
    },
  ],
  inside: {
    tables: [
      {
        name: 'orders',
        displayName: 'Orders',
        rowSchema: { id: 'string', status: 'string' },
        grain: 'app',
      },
    ],
    watchers: [
      { id: 'payment-captured', displayName: 'A payment is captured', event: 'PAYMENT.CAPTURE.COMPLETED' },
    ],
  },
  settings: [
    { id: 'currency', label: 'Currency', kind: 'text', help: 'The three-letter currency your checkout charges in.' },
  ],
  // Webhook triggers discriminate on the body's top-level event_type.
  triggers: [
    { kind: 'webhook', id: 'payment-captured', displayName: 'A payment is captured', eventPath: 'event_type', events: ['PAYMENT.CAPTURE.COMPLETED'] },
    { kind: 'webhook', id: 'order-approved', displayName: 'A buyer approves an order', eventPath: 'event_type', events: ['CHECKOUT.ORDER.APPROVED'] },
    { kind: 'webhook', id: 'payment-refunded', displayName: 'A payment is refunded or reversed', eventPath: 'event_type', events: ['PAYMENT.CAPTURE.REFUNDED', 'PAYMENT.CAPTURE.REVERSED'] },
    { kind: 'webhook', id: 'payment-denied', displayName: 'A payment is denied', eventPath: 'event_type', events: ['PAYMENT.CAPTURE.DENIED'] },
  ],
  fixtures: [
    {
      endpoint: 'create-order',
      params: { amount: '100.00', currency: 'USD' },
      status: 201,
      response: { id: '5O190127TN364715T', status: 'CREATED' },
    },
  ],
};
