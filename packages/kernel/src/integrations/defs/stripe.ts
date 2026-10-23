import type { IntegrationDefInput as IntegrationDef } from '../catalog.js';

// Stripe checkout def (websites only): secret key creates the session server-side; the API is form-encoded with bracket field names.
export const stripe: IntegrationDef = {
  name: 'stripe',
  version: 1,
  displayName: 'Stripe',
  blurb: 'Take payments on your website through your own Stripe account.',
  category: 'payments',
  surfaces: 'website',
  scope: 'builder',
  hosts: ['https://api.stripe.com'],
  auth: {
    kind: 'bearer',
    secretName: 'STRIPE_SECRET_KEY',
    tokenHelp: 'In the Stripe Dashboard under Developers, API keys, copy the Secret key (sk_live_ or sk_test_ while testing). The publishable key rides the page, never here.',
  },
  endpoints: [
    {
      id: 'create-checkout-session',
      displayName: 'Start a checkout',
      method: 'POST',
      path: '/v1/checkout/sessions',
      class: 'write',
      body: 'form',
      params: {
        price_id: { type: 'string', required: true, wire: 'line_items[0][price]', help: 'The Price ID of what is being bought, from your Stripe products.' },
        quantity: { type: 'number', required: true, wire: 'line_items[0][quantity]', help: 'How many.' },
        mode: { type: 'string', required: true, choices: ['payment', 'subscription', 'setup'], help: 'One-time payment, a subscription, or saving a card.' },
        ui_mode: { type: 'string', required: true, choices: ['embedded_page', 'hosted'], help: 'Embedded shows checkout on your page; hosted sends the visitor to Stripe.' },
        return_url: { type: 'string', help: 'Where the visitor lands after paying. Must carry the literal {CHECKOUT_SESSION_ID} for embedded mode.' },
        success_url: { type: 'string', help: 'Hosted mode: where a successful payment lands.' },
      },
      picks: [
        { field: 'id', from: 'id' },
        { field: 'client_secret', from: 'client_secret' },
        { field: 'url', from: 'url' },
        { field: 'status', from: 'status' },
      ],
    },
  ],
  inside: {
    // Card data is never stored here; only the business mirror.
    tables: [
      {
        name: 'checkout-sessions',
        displayName: 'Checkouts',
        rowSchema: { id: 'string', status: 'string', mode: 'string' },
        grain: 'app',
      },
    ],
    // This watcher pairs with the Stripe events webhook.
    watchers: [
      { id: 'payment-landed', displayName: 'A payment lands', event: 'checkout.session.completed' },
    ],
  },
  settings: [
    { id: 'price_id', label: 'Price', kind: 'text', help: 'The default Price ID your checkout sells.' },
    { id: 'mode', label: 'Kind', kind: 'enum', choices: ['payment', 'subscription', 'setup'], help: 'What kind of checkout this is.' },
  ],
  // Trigger rows: the body's top-level 'type' discriminates events.
  triggers: [
    { kind: 'webhook', id: 'checkout-completed', displayName: 'A checkout is completed', eventPath: 'type', events: ['checkout.session.completed', 'checkout.session.async_payment_succeeded'] },
    { kind: 'webhook', id: 'payment-failed', displayName: 'A payment fails', eventPath: 'type', events: ['checkout.session.async_payment_failed', 'payment_intent.payment_failed'] },
    { kind: 'webhook', id: 'refund-issued', displayName: 'A refund is issued', eventPath: 'type', events: ['charge.refunded'] },
    { kind: 'webhook', id: 'subscription-changed', displayName: 'A subscription starts, changes, or ends', eventPath: 'type', events: ['customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted'] },
  ],
  fixtures: [
    {
      // Create response carries the client_secret the page mounts with.
      endpoint: 'create-checkout-session',
      params: { price_id: 'price_1MotwRLkdIwHu7ixYcPLm5uZ', quantity: 1, mode: 'payment', ui_mode: 'embedded_page', return_url: 'https://example.com/return?session_id={CHECKOUT_SESSION_ID}' },
      status: 200,
      response: {
        id: 'cs_test_a11YYufWQzNY63zpQ6QSNRQhkUpVph4WRmzW0zWJO2znZKdVujZ0N0S22u',
        object: 'checkout.session',
        client_secret: 'cs_test_a11YYufWQzNY63zpQ6QSNRQhkUpVph4WRmzW0zWJO2znZKdVujZ0N0S22u_secret_fis',
        mode: 'payment',
        status: 'open',
        url: null,
      },
    },
  ],
};
