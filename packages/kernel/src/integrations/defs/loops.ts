import type { IntegrationDefInput as IntegrationDef } from '../catalog.js';

export const loops: IntegrationDef = {
  name: 'loops',
  version: 1,
  displayName: 'Loops',
  blurb: 'Send transactional email and grow your audience through your own Loops account.',
  category: 'email-marketing',
  surfaces: 'both',
  scope: 'builder',
  hosts: ['https://app.loops.so'],
  auth: {
    kind: 'bearer',
    secretName: 'LOOPS_API_KEY',
    tokenHelp: 'In your Loops dashboard open Settings, then API, and click Generate key.',
  },
  endpoints: [
    {
      id: 'send-transactional',
      displayName: 'Send an email',
      method: 'POST',
      path: '/api/v1/transactional',
      class: 'send',
      params: {
        email: {
          type: 'string',
          required: true,
          help: 'Who receives the email.',
        },
        transactional_id: {
          type: 'string',
          required: true,
          wire: 'transactionalId',
          help: 'The ID of the transactional email you created in Loops.',
        },
        add_to_audience: {
          type: 'boolean',
          wire: 'addToAudience',
          help: 'Also add the recipient to your Loops audience if they are not in it yet.',
        },
      },
      body: 'json',
      picks: [{ field: 'success', from: 'success' }],
    },
    {
      id: 'create-contact',
      displayName: 'Add a contact',
      method: 'POST',
      path: '/api/v1/contacts/create',
      class: 'write',
      params: {
        email: {
          type: 'string',
          required: true,
          help: 'The contact\'s email address.',
        },
        first_name: { type: 'string', wire: 'firstName' },
        last_name: { type: 'string', wire: 'lastName' },
        user_group: {
          type: 'string',
          wire: 'userGroup',
          help: 'A group name for segmenting contacts in Loops.',
        },
        user_id: {
          type: 'string',
          wire: 'userId',
          help: 'Your app\'s own ID for this contact.',
        },
        source: {
          type: 'string',
          help: 'Where this contact came from, shown in Loops.',
        },
        subscribed: {
          type: 'boolean',
          help: 'Whether the contact can receive campaign and loop emails.',
        },
      },
      body: 'json',
      picks: [{ field: 'id', from: 'id' }],
    },
  ],
  inside: {
    tables: [
      {
        name: 'sent-emails',
        displayName: 'Sent emails',
        rowSchema: {
          email: 'string',
          'transactional-id': 'string',
          success: 'boolean',
        },
        grain: 'app',
      },
    ],
    watchers: [],
  },
  settings: [
    {
      id: 'transactional_id',
      label: 'Email template',
      kind: 'text',
      help: 'The transactional email in Loops your app sends when no other is named. Its content lives in Loops.',
    },
    {
      id: 'default_user_group',
      label: 'Contact group',
      kind: 'text',
      help: 'The group new contacts join by default.',
    },
  ],
  fixtures: [
    {
      endpoint: 'send-transactional',
      params: {
        email: 'alex@company.com',
        transactional_id: 'cll42l54f20i1la0lfooe3z12',
        add_to_audience: true,
      },
      status: 200,
      response: { success: true },
    },
    {
      endpoint: 'create-contact',
      params: {
        email: 'alex@company.com',
        first_name: 'Alex',
        last_name: 'Rivera',
        user_group: 'customers',
        user_id: 'usr_7f8e9d0c1b2a',
        subscribed: true,
      },
      status: 200,
      response: { success: true, id: 'clh3k9m2p4q6r8s0t2v4x6z8' },
    },
  ],
};
