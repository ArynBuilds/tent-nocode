// Mailgun email send; basic auth with "api:KEY", domain set once in settings.
import type { IntegrationDefInput as IntegrationDef } from '../catalog.js';

export const mailgun: IntegrationDef = {
  name: 'mailgun',
  version: 1,
  displayName: 'Mailgun',
  blurb: 'Send email from your app through your own Mailgun account.',
  category: 'email-send',
  surfaces: 'both',
  scope: 'builder',
  hosts: ['https://api.mailgun.net'],
  auth: {
    kind: 'basic',
    secretName: 'MAILGUN_API_KEY',
    tokenHelp:
      'Your API key from Settings, then API Keys, in the Mailgun dashboard. Save the one value api:YOUR_KEY - the username is always the word api and your key rides as the password.',
  },
  endpoints: [
    {
      id: 'send-email',
      displayName: 'Send an email',
      method: 'POST',
      path: '/v3/{domain}/messages',
      class: 'send',
      params: {
        domain: {
          type: 'string',
          required: true,
          help: 'Your Mailgun sending domain, like mg.yourdomain.example. Set it once in settings.',
        },
        from: {
          type: 'string',
          required: true,
          help: 'A sender on the domain you verified with Mailgun.',
        },
        to: { type: 'string', required: true },
        subject: { type: 'string', required: true },
        text: { type: 'string', help: 'The plain-text message. Give text, html, or a template.' },
        html: { type: 'string', help: 'The HTML message, if you send one.' },
        cc: { type: 'string' },
        bcc: { type: 'string' },
        template: { type: 'string', help: 'The name of a template stored in your Mailgun account.' },
      },
      body: 'form',
      picks: [{ field: 'id', from: 'id' }],
    },
  ],
  inside: {
    tables: [
      {
        name: 'sent-emails',
        displayName: 'Sent emails',
        rowSchema: { to: 'string', subject: 'string', id: 'string' },
        grain: 'app',
      },
    ],
    watchers: [],
  },
  settings: [
    {
      id: 'domain',
      label: 'Sending domain',
      kind: 'text',
      help: 'The Mailgun domain your app sends through, like mg.yourdomain.example. Not a secret.',
    },
    {
      id: 'default_from',
      label: 'Send as',
      kind: 'text',
      help: 'The address your app sends from by default.',
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
        domain: 'mg.example.com',
        from: 'app@mg.example.com',
        to: 'user@example.com',
        subject: 'Hello',
        text: 'Hi there',
      },
      status: 200,
      response: { id: '<20130522054141.58247.41952@mg.example.com>', message: 'Queued. Thank you.' },
    },
  ],
};
