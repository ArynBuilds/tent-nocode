// Microsoft 365 integration def: send Outlook mail and mirror the calendar into a Table.
import type { IntegrationDefInput as IntegrationDef } from '../catalog.js';

export const microsoftGraph: IntegrationDef = {
  name: 'microsoft-graph',
  version: 1,
  displayName: 'Microsoft 365',
  blurb: 'Send Outlook email and mirror your calendar into a Table from your Microsoft account.',
  category: 'productivity',
  surfaces: 'both',
  scope: 'both',
  // Stays upcoming until an app registration with Microsoft supplies its client id.
  availability: 'upcoming',
  hosts: ['https://graph.microsoft.com'],
  auth: {
    kind: 'oauth',
    authUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    // offline_access is required for the token endpoint to mint a refresh token.
    scopes: ['Mail.Send', 'Calendars.Read', 'offline_access'],
    clientEnv: 'MICROSOFT',
    tokenHelp: 'No key to copy - click Sign in to Microsoft and approve the two permissions it asks for.',
  },
  endpoints: [
    {
      id: 'send-mail',
      displayName: 'Send an email',
      method: 'POST',
      path: '/v1.0/me/sendMail',
      class: 'send',
      body: 'json',
      // Nested Graph envelope built via `at` paths; plain text only.
      bodyConstants: { 'message.body.contentType': 'Text' },
      params: {
        to: {
          type: 'string',
          required: true,
          at: 'message.toRecipients.0.emailAddress.address',
          help: 'Who receives the email.',
        },
        subject: {
          type: 'string',
          required: true,
          at: 'message.subject',
          help: 'The subject line.',
        },
        text: {
          type: 'string',
          required: true,
          at: 'message.body.content',
          help: 'The message as plain text.',
        },
      },
      // sendMail answers 202 with an empty body - nothing to pick.
    },
    {
      id: 'list-events',
      displayName: 'Read calendar events',
      method: 'GET',
      path: '/v1.0/me/events',
      class: 'read',
      params: {
        top: {
          type: 'number',
          wire: '$top',
          help: 'How many events to read per pull, up to 100.',
        },
      },
    },
  ],
  inside: {
    tables: [
      // Sends land here from call params; the response body is empty.
      {
        name: 'sent-emails',
        displayName: 'Sent emails',
        rowSchema: { to: 'string', subject: 'string' },
        grain: 'app',
      },
      // One row per event; nested start/end objects are unreachable by the flat fill and skipped.
      {
        name: 'events',
        displayName: 'Calendar events',
        rowSchema: { id: 'string', subject: 'string' },
        grain: 'app',
        fromArray: 'value',
      },
    ],
    watchers: [],
  },
  // /me/events needs no params, so the mirror runs as soon as the connection is active.
  sync: { endpoint: 'list-events', everyMinutes: 30 },
  settings: [
    {
      id: 'body_template',
      label: 'Message',
      kind: 'template',
      help: 'The message with field slots, or bind an input on screen.',
    },
  ],
  fixtures: [
    {
      endpoint: 'send-mail',
      params: {
        to: 'frannis@contoso.com',
        subject: 'Meet for lunch?',
        text: 'The new cafeteria is open.',
      },
      status: 202,
      response: {},
    },
    {
      endpoint: 'list-events',
      params: { top: 10 },
      status: 200,
      response: {
        value: [
          {
            id: 'AAMkAGIAAAoZDOFAAA=',
            subject: 'Orientation',
            bodyPreview:
              'Dana, this is the time you selected for our orientation. Please bring the notes I sent you.',
            start: { dateTime: '2017-04-21T10:00:00.0000000', timeZone: 'Pacific Standard Time' },
            end: { dateTime: '2017-04-21T12:00:00.0000000', timeZone: 'Pacific Standard Time' },
            organizer: { emailAddress: { name: 'Samantha Booth', address: 'samanthab@contoso.com' } },
          },
        ],
      },
    },
  ],
};
