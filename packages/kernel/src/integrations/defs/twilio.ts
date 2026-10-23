// Twilio SMS + WhatsApp sender; WhatsApp is the same endpoint with whatsapp:-prefixed numbers.
import type { IntegrationDefInput as IntegrationDef } from '../catalog.js';

export const twilio: IntegrationDef = {
  name: 'twilio',
  version: 1,
  displayName: 'Twilio',
  blurb: 'Send SMS and WhatsApp messages from your app through your own Twilio account.',
  category: 'messaging',
  surfaces: 'both',
  scope: 'builder',
  hosts: ['https://api.twilio.com'],
  auth: {
    // Basic auth: one vault value in AccountSid:AuthToken form.
    kind: 'basic',
    secretName: 'TWILIO_API_CREDENTIALS',
    tokenHelp:
      'On the Twilio Console home page (console.twilio.com), copy your Account SID and Auth Token, joined with a colon: AccountSid:AuthToken.',
  },
  endpoints: [
    {
      id: 'send-message',
      displayName: 'Send a message',
      method: 'POST',
      path: '/2010-04-01/Accounts/{account_sid}/Messages.json',
      class: 'send',
      params: {
        // Path slot: the non-secret account identifier, set once in settings.
        account_sid: {
          type: 'string',
          required: true,
          help: 'Your Account SID, starting with AC - shown on the Twilio Console home page. An identifier, not a secret.',
        },
        to: {
          type: 'string',
          required: true,
          wire: 'To',
          help: 'The number to message, like +15551234567. For WhatsApp, prefix it: whatsapp:+15551234567.',
        },
        from: {
          type: 'string',
          required: true,
          wire: 'From',
          help: 'A Twilio number you own, like +15557654321. For WhatsApp, prefix it: whatsapp:+15557654321.',
        },
        body: {
          type: 'string',
          required: true,
          wire: 'Body',
          help: 'The message text.',
        },
      },
      body: 'form',
      picks: [
        { field: 'sid', from: 'sid' },
        { field: 'status', from: 'status' },
      ],
    },
  ],
  inside: {
    // Sent messages land here, app grain.
    tables: [
      {
        name: 'sent-messages',
        displayName: 'Sent messages',
        rowSchema: { to: 'string', body: 'string', sid: 'string', status: 'string' },
        grain: 'app',
      },
    ],
    watchers: [],
  },
  settings: [
    {
      id: 'account_sid',
      label: 'Account SID',
      kind: 'text',
      help: 'Starts with AC, from the Twilio Console home page. Fills the account slot of every send.',
    },
    {
      id: 'channel',
      label: 'Channel',
      kind: 'channel-pick',
      choices: ['sms', 'whatsapp'],
      help: 'SMS sends to plain numbers. WhatsApp uses the same numbers with the whatsapp: prefix, like whatsapp:+15551234567.',
    },
    {
      id: 'default_from',
      label: 'Send from',
      kind: 'text',
      help: 'The Twilio number your app sends from by default.',
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
      endpoint: 'send-message',
      params: {
        account_sid: 'ACXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
        to: '+15005550006',
        from: '+15557654321',
        body: 'Hi there',
      },
      status: 201,
      response: {
        account_sid: 'ACXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
        api_version: '2010-04-01',
        body: 'Hi there',
        date_created: 'Thu, 24 Aug 2023 05:32:57 +0000',
        date_sent: null,
        direction: 'outbound-api',
        from: '+15557654321',
        num_segments: '1',
        sid: 'SMXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
        status: 'queued',
        to: '+15005550006',
      },
    },
    {
      endpoint: 'send-message',
      params: {
        account_sid: 'ACXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
        to: 'whatsapp:+15005550006',
        from: 'whatsapp:+14155238886',
        body: 'Hello, there!',
      },
      status: 201,
      response: {
        account_sid: 'ACXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
        api_version: '2010-04-01',
        body: 'Hello, there!',
        date_created: 'Thu, 24 Aug 2023 05:32:57 +0000',
        date_sent: null,
        direction: 'outbound-api',
        from: 'whatsapp:+14155238886',
        num_segments: '1',
        sid: 'SMXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
        status: 'queued',
        to: 'whatsapp:+15005550006',
      },
    },
  ],
};
