import type { IntegrationDefInput as IntegrationDef } from '../catalog.js';

// Gmail send only; the one accepted body shape is a raw RFC 2822 message, base64url encoded.
export const gmail: IntegrationDef = {
  name: 'gmail',
  version: 1,
  displayName: 'Gmail',
  blurb: 'Send email from your app through a signed-in Gmail account.',
  category: 'email-send',
  surfaces: 'both',
  scope: 'both',
  availability: 'upcoming',
  hosts: ['https://gmail.googleapis.com'],
  auth: {
    // One vendor app serves the whole Google family (clientEnv GOOGLE).
    kind: 'oauth',
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scopes: ['https://www.googleapis.com/auth/gmail.send'],
    clientEnv: 'GOOGLE',
    tokenHelp: 'Sign in with Google when Gmail goes live - there is no key to find or paste, ever.',
  },
  endpoints: [
    {
      id: 'send-email',
      displayName: 'Send an email',
      method: 'POST',
      // userId pinned to "me": only the signed-in account can be the sender.
      path: '/gmail/v1/users/me/messages/send',
      class: 'send',
      body: 'json',
      params: {
        raw: {
          type: 'string',
          required: true,
          help: 'The whole email as an RFC 2822 message, base64url encoded - the one shape Gmail accepts.',
        },
      },
      picks: [
        { field: 'id', from: 'id' },
        { field: 'thread_id', from: 'threadId' },
      ],
    },
  ],
  inside: {
    // Where sends land; to/subject live inside the encoded raw message and cannot be logged.
    tables: [
      {
        name: 'sent-emails',
        displayName: 'Sent emails',
        rowSchema: { id: 'string', 'thread-id': 'string' },
        grain: 'app',
      },
    ],
    watchers: [],
  },
  settings: [
    { id: 'body_template', label: 'Message', kind: 'template', help: 'The message with field slots, or bind an input on screen.' },
  ],
  fixtures: [
    {
      endpoint: 'send-email',
      params: {
        raw: 'RnJvbTogbWVAZXhhbXBsZS5jb20NClRvOiB1c2VyQGV4YW1wbGUuY29tDQpTdWJqZWN0OiBIZWxsbw0KDQpIaSB0aGVyZQ',
      },
      status: 200,
      response: { id: '17f2c3d4e5a6b7c8', threadId: '17f2c3d4e5a6b7c8', labelIds: ['SENT'] },
    },
  ],
};
