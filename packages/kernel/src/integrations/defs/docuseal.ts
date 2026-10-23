import type { IntegrationDefInput as IntegrationDef } from '../catalog.js';

// DocuSeal e-signature; the create response is a top-level array, so picks use '0.field' paths.
export const docuseal: IntegrationDef = {
  name: 'docuseal',
  version: 1,
  displayName: 'DocuSeal',
  blurb: 'Send documents for signature from your app through your own DocuSeal account.',
  category: 'e-sign',
  surfaces: 'both',
  scope: 'builder',
  hosts: ['https://api.docuseal.com'],
  auth: {
    kind: 'header',
    header: 'x-auth-token',
    secretName: 'DOCUSEAL_API_KEY',
    tokenHelp: 'Sign in to DocuSeal, open the API page under your account settings, and copy your API key.',
  },
  endpoints: [
    {
      id: 'create-submission',
      displayName: 'Send a document for signature',
      method: 'POST',
      path: '/submissions',
      class: 'send',
      params: {
        template_id: {
          type: 'number',
          required: true,
          help: 'The DocuSeal template holding the document to sign.',
        },
        email: {
          type: 'string',
          required: true,
          at: 'submitters.0.email',
          help: 'Where the signature request goes.',
        },
        name: {
          type: 'string',
          at: 'submitters.0.name',
          help: 'The signer name, if you have it.',
        },
        role: {
          type: 'string',
          at: 'submitters.0.role',
          help: 'The template role this signer fills, like First Party. The template decides when left out.',
        },
      },
      body: 'json',
      picks: [
        { field: 'submission_id', from: '0.submission_id' },
        { field: 'status', from: '0.status' },
        { field: 'slug', from: '0.slug' },
      ],
    },
    {
      id: 'get-submission',
      displayName: 'Check a signature request',
      method: 'GET',
      path: '/submissions/{submission_id}',
      class: 'read',
      params: {
        submission_id: {
          type: 'number',
          required: true,
          help: 'The signature request to check, from the send call.',
        },
      },
      picks: [
        { field: 'status', from: 'status' },
        { field: 'completed_at', from: 'completed_at' },
        { field: 'audit_log_url', from: 'audit_log_url' },
        { field: 'document_url', from: 'documents.0.url' },
        { field: 'email', from: 'submitters.0.email' },
      ],
    },
  ],
  inside: {
    // Signature requests land once per app; columns fill by name from call params then picks.
    tables: [
      {
        name: 'submissions',
        displayName: 'Signature requests',
        rowSchema: {
          'submission-id': 'number',
          'template-id': 'number',
          email: 'string',
          status: 'string',
          'completed-at': 'string',
        },
        grain: 'app',
      },
    ],
    watchers: [
      { id: 'submission-completed', displayName: 'When the document is fully signed', event: 'submission.completed' },
    ],
  },
  settings: [
    {
      id: 'default_template_id',
      label: 'Template',
      kind: 'number',
      help: 'The DocuSeal template your app sends when a call does not name one.',
    },
  ],
  fixtures: [
    {
      endpoint: 'create-submission',
      params: { template_id: 1000001, email: 'john.doe@example.com', role: 'First Party' },
      status: 200,
      response: [
        {
          id: 1,
          submission_id: 1,
          uuid: '884d545b-3396-49f1-8c07-05b8b2a78755',
          email: 'john.doe@example.com',
          slug: 'pAMimKcyrLjqVt',
          sent_at: '2023-12-13T23:04:04.252Z',
          opened_at: null,
          completed_at: null,
          declined_at: null,
          created_at: '2023-12-14T15:50:21.799Z',
          updated_at: '2023-12-14T15:50:21.799Z',
          name: 'John Doe',
          status: 'sent',
          role: 'First Party',
          preferences: { send_email: true, send_sms: false },
          embed_src: 'https://docuseal.com/s/pAMimKcyrLjqVt',
        },
      ],
    },
    {
      endpoint: 'get-submission',
      params: { submission_id: 1 },
      status: 200,
      response: {
        id: 1,
        status: 'completed',
        created_at: '2023-12-10T15:48:17.166Z',
        completed_at: '2023-12-14T15:49:21.701Z',
        audit_log_url: 'https://docuseal.com/blobs/proxy/hash/example.pdf',
        submitters: [
          {
            id: 1,
            email: 'submitter@example.com',
            name: 'John Doe',
            status: 'completed',
            role: 'First Party',
          },
        ],
        documents: [
          { name: 'example', url: 'https://docuseal.com/file/hash/example.pdf' },
        ],
        template: { id: 1, name: 'Example Template', external_id: 'Temp123', folder_name: 'Default' },
      },
    },
  ],
};
