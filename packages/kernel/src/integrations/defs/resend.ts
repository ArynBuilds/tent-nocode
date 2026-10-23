// Resend email-send def; sends fire from the builder's own key, text-only body.
import type { IntegrationDefInput as IntegrationDef } from '../catalog.js';

export const resend: IntegrationDef = {
  name: 'resend',
  version: 1,
  displayName: 'Resend',
  blurb: 'Send email from your app through your own Resend account.',
  category: 'email-send',
  surfaces: 'both',
  scope: 'builder',
  hosts: ['https://api.resend.com'],
  auth: {
    kind: 'bearer',
    secretName: 'RESEND_API_KEY',
    tokenHelp: 'Create an API key on the API Keys page of your Resend dashboard (resend.com/api-keys).',
  },
  endpoints: [
    {
      id: 'send-email',
      displayName: 'Send an email',
      method: 'POST',
      path: '/emails',
      class: 'send',
      params: {
        from: { type: 'string', required: true, help: 'A sender address on a domain you verified with Resend.' },
        to: { type: 'string', required: true, help: 'Who receives the email.' },
        subject: { type: 'string', required: true, help: 'The subject line.' },
        text: { type: 'string', required: true, help: 'The message as plain text.' },
      },
      body: 'json',
      picks: [{ field: 'id', from: 'id' }],
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
    {
      endpoint: 'send-email',
      params: {
        from: 'Acme <onboarding@yourdomain.example>',
        to: 'delivered@resend.dev',
        subject: 'Hello',
        text: 'It works!',
      },
      status: 200,
      response: { id: '49a3999c-0ce1-4ea6-ab68-afcd6dc2e794' },
    },
  ],
};
