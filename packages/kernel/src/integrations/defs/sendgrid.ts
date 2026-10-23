// SendGrid email-send def: 202 success has no body, so the message id reads off the X-Message-Id response header.
import type { IntegrationDefInput as IntegrationDef } from '../catalog.js';

export const sendgrid: IntegrationDef = {
  name: 'sendgrid',
  version: 1,
  displayName: 'SendGrid',
  blurb: 'Send email from your app through your own SendGrid account.',
  category: 'email-send',
  surfaces: 'both',
  scope: 'builder',
  hosts: ['https://api.sendgrid.com'],
  auth: {
    kind: 'bearer',
    secretName: 'SENDGRID_API_KEY',
    tokenHelp: 'Create an API key under Settings, then API Keys, in your SendGrid dashboard (app.sendgrid.com/settings/api_keys).',
  },
  endpoints: [
    {
      id: 'send-email',
      displayName: 'Send an email',
      method: 'POST',
      path: '/v3/mail/send',
      class: 'send',
      params: {
        from: { type: 'string', required: true, at: 'from.email', help: 'A sender address you verified with SendGrid.' },
        to: { type: 'string', required: true, at: 'personalizations.0.to.0.email', help: 'Who receives the email.' },
        subject: { type: 'string', required: true, help: 'The subject line.' },
        text: { type: 'string', required: true, at: 'content.0.value', help: 'The message body.' },
        // SendGrid requires content.0.type; it rides as a required param because the grammar has no constant body field.
        format: { type: 'string', required: true, choices: ['text/plain', 'text/html'], at: 'content.0.type', help: 'How the message body is read: plain text or HTML.' },
      },
      body: 'json',
      // The 202 success has no body; the id rides the response header.
      picks: [{ field: 'message_id', fromHeader: 'X-Message-Id' }],
    },
  ],
  inside: {
    // Sent log: pulled once per app, read by every user, user-unwritable.
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
    { id: 'default_from', label: 'Send as', kind: 'text', help: 'The address your app sends from by default.' },
    // The message is a template with field slots or a binding from an on-screen input.
    { id: 'body_template', label: 'Message', kind: 'template', help: 'The message with field slots, or bind an input on screen.' },
  ],
  fixtures: [
    // SendGrid answers 202 with no body; fixtures cannot record the id header.
    {
      endpoint: 'send-email',
      params: {
        from: 'app@yourdomain.example',
        to: 'john.doe@example.com',
        subject: 'Hello, World!',
        text: 'Heya!',
        format: 'text/plain',
      },
      status: 202,
      response: null,
    },
  ],
};
