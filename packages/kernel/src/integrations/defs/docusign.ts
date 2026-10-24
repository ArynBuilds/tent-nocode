// DocuSign e-signature via the template lane; API calls ride the account's own server, so the host is a template.
import type { IntegrationDefInput as IntegrationDef } from '../catalog.js';

export const docusign: IntegrationDef = {
  name: 'docusign',
  version: 1,
  displayName: 'DocuSign',
  blurb: 'Send documents for signature through your own DocuSign account and track when they are signed.',
  category: 'e-sign',
  surfaces: 'both',
  scope: 'builder',
  // Upcoming until the DocuSign app is registered.
  availability: 'upcoming',
  // The account's own server under the fixed docusign.net suffix.
  hosts: { template: 'https://{server}.docusign.net', slot: 'server' },
  auth: {
    kind: 'oauth',
    authUrl: 'https://account.docusign.com/oauth/auth',
    tokenUrl: 'https://account.docusign.com/oauth/token',
    scopes: ['signature'],
    clientEnv: 'DOCUSIGN',
    tokenHelp: 'Click Sign in to DocuSign and approve access - Nodeloom holds the sign-in, you never paste a key.',
  },
  endpoints: [
    {
      id: 'send-envelope',
      displayName: 'Send a document for signature',
      method: 'POST',
      path: '/restapi/v2.1/accounts/{account_id}/envelopes',
      class: 'send',
      body: 'json',
      // Status 'sent' makes the create an actual send, not a draft.
      bodyConstants: { status: 'sent' },
      params: {
        account_id: {
          type: 'string',
          required: true,
          help: 'Your API account ID, from the Apps and Keys page - or set it once on the node.',
        },
        template_id: {
          type: 'string',
          required: true,
          wire: 'templateId',
          help: 'The DocuSign template holding the document to sign.',
        },
        email: {
          type: 'string',
          required: true,
          at: 'templateRoles.0.email',
          help: 'Where the signature request goes.',
        },
        name: {
          type: 'string',
          required: true,
          at: 'templateRoles.0.name',
          help: 'The signer name - DocuSign requires it.',
        },
        role_name: {
          type: 'string',
          required: true,
          at: 'templateRoles.0.roleName',
          help: 'The template role this signer fills, like Signer1 - it must match the template.',
        },
      },
      picks: [
        { field: 'envelope_id', from: 'envelopeId' },
        { field: 'status', from: 'status' },
      ],
    },
    {
      id: 'get-envelope',
      displayName: 'Check a signature request',
      method: 'GET',
      path: '/restapi/v2.1/accounts/{account_id}/envelopes/{envelope_id}',
      class: 'read',
      params: {
        account_id: {
          type: 'string',
          required: true,
          help: 'Your API account ID, from the Apps and Keys page - or set it once on the node.',
        },
        envelope_id: {
          type: 'string',
          required: true,
          help: 'The signature request to check, from the send call.',
        },
      },
      picks: [
        { field: 'status', from: 'status' },
        { field: 'subject', from: 'emailSubject' },
        { field: 'sent_at', from: 'sentDateTime' },
        { field: 'completed_at', from: 'completedDateTime' },
      ],
    },
  ],
  inside: {
    // Signature requests land once per app; columns fill by name from params then picks.
    tables: [
      {
        name: 'envelopes',
        displayName: 'Signature requests',
        rowSchema: {
          'envelope-id': 'string',
          'template-id': 'string',
          email: 'string',
          status: 'string',
          'completed-at': 'string',
        },
        grain: 'app',
      },
    ],
    watchers: [
      { id: 'envelope-completed', displayName: 'When the document is fully signed', event: 'envelope-completed' },
    ],
  },
  settings: [
    // 'account_id' matches the param on both endpoints - set once, every call fills it.
    {
      id: 'account_id',
      label: 'Account ID',
      kind: 'text',
      help: 'Your API account ID - DocuSign shows it on the Apps and Keys page.',
    },
    {
      id: 'default_template_id',
      label: 'Template',
      kind: 'text',
      help: 'The DocuSign template your app sends when a call does not name one.',
    },
    {
      id: 'default_role_name',
      label: 'Signer role',
      kind: 'text',
      help: 'The template role your signers fill when a call does not name one, like Signer1.',
    },
  ],
  fixtures: [
    {
      endpoint: 'send-envelope',
      params: {
        account_id: 'a1d5a471-24cd-4a3e-8b7a-0f1e2d3c4b5a',
        template_id: '4d29f260-1e2b-4e3a-9f00-1a2b3c4d5e6f',
        email: 'jane.smith@example.com',
        name: 'Jane Smith',
        role_name: 'Signer1',
      },
      status: 201,
      response: {
        envelopeId: '79b134fd-b28d-4a34-9be5-1e2c3d4f5a6b',
        uri: '/envelopes/79b134fd-b28d-4a34-9be5-1e2c3d4f5a6b',
        statusDateTime: '2026-08-15T09:12:33.1230000Z',
        status: 'sent',
      },
    },
    {
      endpoint: 'get-envelope',
      params: {
        account_id: 'a1d5a471-24cd-4a3e-8b7a-0f1e2d3c4b5a',
        envelope_id: '79b134fd-b28d-4a34-9be5-1e2c3d4f5a6b',
      },
      status: 200,
      response: {
        envelopeId: '79b134fd-b28d-4a34-9be5-1e2c3d4f5a6b',
        status: 'completed',
        emailSubject: 'Please sign: Service Agreement',
        sentDateTime: '2026-08-15T09:12:33.1230000Z',
        deliveredDateTime: '2026-08-15T09:14:02.0000000Z',
        completedDateTime: '2026-08-15T09:20:45.0000000Z',
        statusChangedDateTime: '2026-08-15T09:20:45.0000000Z',
      },
    },
  ],
};
