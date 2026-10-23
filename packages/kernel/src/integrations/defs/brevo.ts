import type { IntegrationDefInput as IntegrationDef } from '../catalog.js';

// Brevo transactional email over the v3 REST API; auth rides the 'api-key' header.
export const brevo: IntegrationDef = {
  name: 'brevo',
  version: 1,
  displayName: 'Brevo',
  blurb: 'Send email from your app through your own Brevo account.',
  category: 'email-send',
  surfaces: 'both',
  scope: 'builder',
  hosts: ['https://api.brevo.com'],
  auth: {
    kind: 'header',
    header: 'api-key',
    secretName: 'BREVO_API_KEY',
    tokenHelp: 'Create a key under SMTP & API, then API Keys, in your Brevo account.',
  },
  endpoints: [
    {
      id: 'send-email',
      displayName: 'Send an email',
      method: 'POST',
      path: '/v3/smtp/email',
      class: 'send',
      params: {
        from: {
          type: 'string',
          required: true,
          at: 'sender.email',
          help: 'A sender address you verified with Brevo.',
        },
        from_name: {
          type: 'string',
          at: 'sender.name',
          help: 'The name shown beside the sender address.',
        },
        to: {
          type: 'string',
          required: true,
          at: 'to.0.email',
          help: 'Who receives the email.',
        },
        to_name: {
          type: 'string',
          at: 'to.0.name',
        },
        subject: {
          type: 'string',
          required: true,
        },
        html: {
          type: 'string',
          required: true,
          wire: 'htmlContent',
          help: 'The message body, as HTML or plain words.',
        },
        text: {
          type: 'string',
          wire: 'textContent',
          help: 'A plain-text version of the message.',
        },
      },
      body: 'json',
      picks: [{ field: 'message_id', from: 'messageId' }],
    },
  ],
  inside: {
    // The sent-log table where sends land.
    tables: [
      {
        name: 'sent-emails',
        displayName: 'Sent emails',
        rowSchema: { to: 'string', subject: 'string', 'message-id': 'string' },
        grain: 'app',
      },
    ],
    watchers: [],
  },
  settings: [
    {
      id: 'default_from',
      label: 'Send as',
      kind: 'text',
      help: 'The address your app sends from by default.',
    },
    {
      id: 'default_from_name',
      label: 'Sender name',
      kind: 'text',
      help: 'The name shown beside the sender address by default.',
    },
    {
      id: 'body_template',
      label: 'Message',
      kind: 'template',
      help: 'The message with field slots, or bind an input on screen.',
    },
  ],
  fixtures: [
    {
      endpoint: 'send-email',
      params: {
        from: 'hello@yourdomain.example',
        from_name: 'Alex from Brevo',
        to: 'johndoe@example.com',
        to_name: 'John Doe',
        subject: 'Hello from Brevo!',
        html: '<html><body><p>Hello,</p><p>This is my first transactional email.</p></body></html>',
      },
      status: 201,
      response: { messageId: '<201798300811.5787683@relay.domain.com>' },
    },
  ],
};
