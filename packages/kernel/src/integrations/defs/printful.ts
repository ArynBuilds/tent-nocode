// Printful fulfillment def: create lands a draft, a separate confirm call submits it; one line item per call; store-scoped token only.
import type { IntegrationDefInput as IntegrationDef } from '../catalog.js';

export const printful: IntegrationDef = {
  name: 'printful',
  version: 1,
  displayName: 'Printful',
  blurb: 'Create print-on-demand orders in your own Printful store and follow them to delivery.',
  category: 'fulfillment',
  surfaces: 'both',
  scope: 'builder',
  hosts: ['https://api.printful.com'],
  auth: {
    kind: 'bearer',
    secretName: 'PRINTFUL_API_KEY',
    tokenHelp: 'Create a private token under Developers, then Tokens, in your Printful dashboard - pick a token scoped to your store (store-scoped tokens work directly; account-level tokens need an extra header this connector does not carry).',
  },
  endpoints: [
    {
      id: 'create-order',
      displayName: 'Create an order',
      method: 'POST',
      path: '/orders',
      // Creates a draft; drafts are never charged.
      class: 'write',
      params: {
        external_id: { type: 'string', help: 'Your own order number - find this order later with @ followed by this id.' },
        recipient_name: { type: 'string', required: true, at: 'recipient.name', help: 'Who receives the package.' },
        recipient_address1: { type: 'string', required: true, at: 'recipient.address1', help: 'Street address.' },
        recipient_city: { type: 'string', required: true, at: 'recipient.city' },
        recipient_state_code: { type: 'string', at: 'recipient.state_code', help: 'Needed for US and Canada addresses, like CA.' },
        recipient_country_code: { type: 'string', required: true, at: 'recipient.country_code', help: 'Two-letter country code, like US.' },
        recipient_zip: { type: 'string', required: true, at: 'recipient.zip', help: 'ZIP or postal code.' },
        recipient_email: { type: 'string', at: 'recipient.email' },
        variant_id: { type: 'number', required: true, at: 'items.0.variant_id', help: 'The Printful catalog variant to print - the exact product, size, and color.' },
        quantity: { type: 'number', required: true, at: 'items.0.quantity', help: 'How many of this item.' },
        file_url: { type: 'string', required: true, at: 'items.0.files.0.url', help: 'Public URL of the print file image.' },
        shipping: { type: 'string', help: 'Shipping method. Printful uses STANDARD when unset.' },
      },
      body: 'json',
      picks: [
        { field: 'order_id', from: 'result.id' },
        { field: 'status', from: 'result.status' },
        { field: 'total', from: 'result.costs.total' },
      ],
    },
    {
      id: 'confirm-order',
      displayName: 'Submit an order for fulfillment',
      method: 'POST',
      path: '/orders/{order_id}/confirm',
      // The money-moving step: a confirmed order is charged and fulfilled.
      class: 'write',
      params: {
        order_id: { type: 'string', required: true, help: 'The Printful order number, or @ followed by your own order number.' },
      },
      body: 'json',
      picks: [
        { field: 'order_id', from: 'result.id' },
        { field: 'status', from: 'result.status' },
      ],
    },
    {
      id: 'get-order',
      displayName: 'Check an order',
      method: 'GET',
      path: '/orders/{order_id}',
      class: 'read',
      params: {
        order_id: { type: 'string', required: true, help: 'The Printful order number, or @ followed by your own order number.' },
      },
      picks: [
        { field: 'order_id', from: 'result.id' },
        { field: 'status', from: 'result.status' },
        { field: 'total', from: 'result.costs.total' },
        { field: 'created', from: 'result.created' },
      ],
    },
  ],
  inside: {
    // Orders log: app-grain, read by every user, user-unwritable.
    tables: [
      {
        name: 'orders',
        displayName: 'Orders',
        rowSchema: {
          'order-id': 'number',
          status: 'string',
          'recipient-name': 'string',
          'variant-id': 'number',
          quantity: 'number',
          total: 'number',
        },
        grain: 'app',
      },
    ],
    watchers: [],
  },
  settings: [
    // default_<param> fills the param when the caller leaves it unset.
    { id: 'default_shipping', label: 'Shipping method', kind: 'text', help: 'How orders ship when nothing else is picked. Printful uses STANDARD when unset.' },
    { id: 'default_quantity', label: 'Quantity', kind: 'number', help: 'How many of an item an order carries when nothing else is picked.' },
  ],
  fixtures: [
    // A fresh create answers with the draft order inside the {code, result} envelope.
    {
      endpoint: 'create-order',
      params: {
        external_id: '4235234213',
        recipient_name: 'John Smith',
        recipient_address1: '19749 Dearborn St',
        recipient_city: 'Chatsworth',
        recipient_state_code: 'CA',
        recipient_country_code: 'US',
        recipient_zip: '91311',
        variant_id: 4012,
        quantity: 1,
        file_url: 'https://www.example.com/files/tshirts/example.png',
      },
      status: 200,
      response: {
        code: 200,
        result: {
          id: 13,
          external_id: '4235234213',
          status: 'draft',
          shipping: 'STANDARD',
          created: 1602607640,
          updated: 1602607640,
          costs: { currency: 'USD', subtotal: '10.00', discount: '0.00', shipping: '5.00', tax: '0.00', total: '15.00' },
        },
      },
    },
    // Submitting the draft flips it to pending.
    {
      endpoint: 'confirm-order',
      params: { order_id: '13' },
      status: 200,
      response: {
        code: 200,
        result: {
          id: 13,
          external_id: '4235234213',
          status: 'pending',
          shipping: 'STANDARD',
          created: 1602607640,
          updated: 1602607641,
        },
      },
    },
    // A later read on the same order, mid-fulfillment.
    {
      endpoint: 'get-order',
      params: { order_id: '13' },
      status: 200,
      response: {
        code: 200,
        result: {
          id: 13,
          external_id: '4235234213',
          status: 'inprocess',
          shipping: 'STANDARD',
          created: 1602607640,
          updated: 1602607800,
          costs: { currency: 'USD', subtotal: '10.00', discount: '0.00', shipping: '5.00', tax: '0.00', total: '15.00' },
        },
      },
    },
  ],
};
