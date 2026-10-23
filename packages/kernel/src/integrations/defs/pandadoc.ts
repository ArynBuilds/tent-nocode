// PandaDoc integration def: create-from-template is async - poll status until document.draft before sending.
import type { IntegrationDefInput as IntegrationDef } from '../catalog.js';

export const pandadoc: IntegrationDef = {
  name: 'pandadoc',
  version: 1,
  displayName: 'PandaDoc',
  blurb: 'Create, send, and track e-sign documents from your own PandaDoc account.',
  category: 'e-sign',
  surfaces: 'both',
  scope: 'builder',
  hosts: ['https://api.pandadoc.com'],
  auth: {
    kind: 'bearer',
    scheme: 'API-Key',
    secretName: 'PANDADOC_API_KEY',
    tokenHelp: 'Create an API key on the Configuration page of your PandaDoc Developer Dashboard.',
  },
  endpoints: [
    {
      id: 'create-document',
      displayName: 'Create a document from a template',
      method: 'POST',
      path: '/public/v1/documents',
      class: 'write',
      params: {
        template_uuid: { type: 'string', required: true, help: 'The ID of the PandaDoc template to create from.' },
        name: { type: 'string', required: true, help: 'The name of the new document.' },
        recipient_email: { type: 'string', required: true, at: 'recipients.0.email', help: 'Who signs this document.' },
        recipient_first_name: { type: 'string', at: 'recipients.0.first_name' },
        recipient_last_name: { type: 'string', at: 'recipients.0.last_name' },
        recipient_role: { type: 'string', at: 'recipients.0.role', help: 'The recipient role name from the template, like Client.' },
      },
      body: 'json',
      picks: [
        { field: 'document_id', from: 'id' },
        { field: 'status', from: 'status' },
      ],
    },
    {
      id: 'send-document',
      displayName: 'Send a document for signing',
      method: 'POST',
      path: '/public/v1/documents/{document_id}/send',
      class: 'send',
      params: {
        document_id: { type: 'string', required: true, help: 'The document to send. Create it from a template first and wait until it is a draft.' },
        subject: { type: 'string', help: 'The subject of the signing email.' },
        message: { type: 'string', help: 'The message sent with the link to sign.' },
        silent: { type: 'boolean', help: 'Send without email notifications.' },
      },
      body: 'json',
      picks: [
        { field: 'status', from: 'status' },
        { field: 'name', from: 'name' },
      ],
    },
    {
      id: 'document-status',
      displayName: 'Check a document’s status',
      method: 'GET',
      path: '/public/v1/documents/{document_id}',
      class: 'read',
      params: {
        document_id: { type: 'string', required: true, help: 'The document to look up.' },
      },
      picks: [
        { field: 'status', from: 'status' },
        { field: 'name', from: 'name' },
        { field: 'date_modified', from: 'date_modified' },
      ],
    },
  ],
  inside: {
    tables: [
      {
        name: 'documents',
        displayName: 'Documents',
        rowSchema: {
          'name': 'string',
          'document-id': 'string',
          'template-uuid': 'string',
          'status': 'string',
          'recipient-email': 'string',
        },
        grain: 'app',
      },
    ],
    watchers: [],
  },
  settings: [
    { id: 'default_template_uuid', label: 'Template', kind: 'text', help: 'The template ID new documents are created from by default.' },
    { id: 'default_subject', label: 'Email subject', kind: 'text', help: 'The default subject of the signing email.' },
    { id: 'message', label: 'Message', kind: 'template', help: 'The message with field slots, or bind an input on screen.' },
  ],
  fixtures: [
    {
      endpoint: 'create-document',
      params: {
        template_uuid: 'onoznwTq4Y3EELMPyvucnc',
        name: 'Simple API Sample Document from PandaDoc Template',
        recipient_email: 'josh@example.com',
        recipient_first_name: 'Josh',
        recipient_last_name: 'Ron',
        recipient_role: 'user',
      },
      status: 201,
      response: {
        id: 'D3okRfgHRX7NEhavcACReB',
        name: 'Document from Template',
        status: 'document.uploaded',
        date_created: '2024-07-04T19:27:14.927317Z',
        date_modified: '2024-07-04T19:27:14.927317Z',
        expiration_date: null,
        version: null,
        uuid: 'D3okRfgHRX7NEhavcACReB',
        links: [
          { rel: 'status', href: 'https://api.pandadoc.com/public/v1/documents/D3okRfgHRX7NEhavcACReB', type: 'GET' },
        ],
        info_message: 'You need to poll the Document Status method until the status will be changed to document.draft',
      },
    },
    {
      endpoint: 'send-document',
      params: {
        document_id: 'msFYActMfJHqNTKH8YSvF1',
        subject: 'Please sign this document',
        message: 'Hello! This document was sent from the PandaDoc API.',
      },
      status: 200,
      response: {
        id: 'msFYActMfJHqNTKH8YSvF1',
        name: 'API Sample Document from PandaDoc Template',
        status: 'document.sent',
        date_created: '2018-02-06T08:42:13.836022Z',
        date_modified: '2018-02-06T08:42:13.836022Z',
        date_completed: '2021-10-23T21:07:04.147345Z',
        recipients: [
          {
            id: '7kqXgjFejB2toXxjcC5jfZ',
            email: 'test@test.com',
            recipient_type: 'signer',
            shared_link: 'https://app.pandadoc.com/document/7kqXgjFejB2toXxjcC5jfZ',
          },
        ],
      },
    },
    {
      endpoint: 'document-status',
      params: { document_id: 'XjV64iXRJMerjSpk428QSF' },
      status: 200,
      response: {
        id: 'XjV64iXRJMerjSpk428QSF',
        name: 'Document from template',
        status: 'document.draft',
        date_created: '2024-03-19T12:59:52.848666Z',
        date_modified: '2024-03-19T12:59:53.957830Z',
        date_completed: null,
        expiration_date: null,
        version: '2',
        uuid: 'XjV64iXRJMerjSpk428QSF',
      },
    },
  ],
};
