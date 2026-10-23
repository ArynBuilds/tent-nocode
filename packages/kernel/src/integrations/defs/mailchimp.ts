import type { IntegrationDefInput as IntegrationDef } from '../catalog.js';

// Mailchimp subscriber add and campaign send; API key ends with data center code filling {dc} host slot.
export const mailchimp: IntegrationDef = {
  name: 'mailchimp',
  version: 1,
  displayName: 'Mailchimp',
  blurb: 'Grow your Mailchimp audience and send campaigns from your own account.',
  category: 'email-marketing',
  surfaces: 'both',
  scope: 'builder',
  hosts: { template: 'https://{dc}.api.mailchimp.com', slot: 'dc' },
  auth: {
    kind: 'bearer',
    secretName: 'MAILCHIMP_API_KEY',
    tokenHelp:
      'Create an API key in Mailchimp under Account, Extras, API keys. The key ends with your data center code (like -us6) - type that code, without the dash, as the dc when you connect.',
  },
  endpoints: [
    {
      id: 'add-member',
      displayName: 'Add a subscriber',
      method: 'POST',
      path: '/3.0/lists/{list_id}/members',
      class: 'write',
      params: {
        list_id: {
          type: 'string',
          required: true,
          help: 'The audience ID, found in Mailchimp under Audience, Settings, Audience name and defaults.',
        },
        email_address: {
          type: 'string',
          required: true,
          help: 'The email address to add to the audience.',
        },
        status: {
          type: 'string',
          required: true,
          choices: ['subscribed', 'unsubscribed', 'cleaned', 'pending'],
          help: 'Use pending to send a confirmation email, subscribed to add directly.',
        },
      },
      body: 'json',
      picks: [
        { field: 'id', from: 'id' },
        { field: 'email_address', from: 'email_address' },
        { field: 'status', from: 'status' },
      ],
    },
    {
      id: 'send-campaign',
      displayName: 'Send a campaign',
      method: 'POST',
      path: '/3.0/campaigns/{campaign_id}/actions/send',
      class: 'send',
      params: {
        campaign_id: {
          type: 'string',
          required: true,
          help: 'The ID of a campaign you already drafted in Mailchimp.',
        },
      },
    },
  ],
  inside: {
    tables: [
      {
        name: 'audience',
        displayName: 'Audience',
        rowSchema: { 'email-address': 'string', status: 'string', id: 'string' },
        grain: 'app',
      },
    ],
    watchers: [],
  },
  settings: [
    {
      id: 'list_id',
      label: 'Audience',
      kind: 'text',
      help: 'The audience new subscribers join, from Audience, Settings, Audience name and defaults.',
    },
  ],
  triggers: [
    { kind: 'webhook', id: 'subscriber-added', displayName: 'Subscriber added', eventPath: 'type', events: ['subscribe'] },
    { kind: 'webhook', id: 'subscriber-left', displayName: 'Subscriber left', eventPath: 'type', events: ['unsubscribe', 'cleaned'] },
    { kind: 'webhook', id: 'subscriber-updated', displayName: 'Subscriber details changed', eventPath: 'type', events: ['profile', 'upemail'] },
    { kind: 'webhook', id: 'campaign-sent', displayName: 'Campaign sent', eventPath: 'type', events: ['campaign'] },
  ],
  fixtures: [
    {
      endpoint: 'add-member',
      params: {
        list_id: 'a1b2c3d4e5',
        email_address: 'urist.mcvankab@freddiesjokes.com',
        status: 'subscribed',
      },
      status: 200,
      response: {
        id: '852aaa9532cb36adfb5e9fef7a4206a9',
        email_address: 'urist.mcvankab@freddiesjokes.com',
        status: 'subscribed',
      },
    },
    {
      endpoint: 'send-campaign',
      params: { campaign_id: 'b03bfc273a' },
      status: 204,
      response: {},
    },
  ],
};
