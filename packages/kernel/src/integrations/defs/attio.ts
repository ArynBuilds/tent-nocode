// Attio CRM: record creation as nested data.values (personal-name wants all three name parts); list reads as POST /records/query.
import type { IntegrationDefInput as IntegrationDef } from '../catalog.js';

export const attio: IntegrationDef = {
  name: 'attio',
  version: 1,
  displayName: 'Attio',
  blurb: 'Bring your Attio people and companies into your app and add new ones from it.',
  category: 'crm',
  surfaces: 'both',
  scope: 'builder',
  hosts: ['https://api.attio.com'],
  auth: {
    kind: 'bearer',
    secretName: 'ATTIO_ACCESS_TOKEN',
    tokenHelp: 'In Attio, open Workspace settings, then the Developers tab, then New access token - give it record read-write scope.',
  },
  endpoints: [
    {
      id: 'create-person',
      displayName: 'Add a person',
      method: 'POST',
      path: '/v2/objects/people/records',
      class: 'write',
      params: {
        first_name: { type: 'string', required: true, at: 'data.values.name.first_name', help: 'The first name.' },
        last_name: { type: 'string', required: true, at: 'data.values.name.last_name', help: 'The last name.' },
        full_name: { type: 'string', required: true, at: 'data.values.name.full_name', help: 'First and last together - Attio wants all three name parts.' },
        email_address: { type: 'string', at: 'data.values.email_addresses.0', help: 'The email address, if you have one.' },
      },
      body: 'json',
      picks: [
        { field: 'record_id', from: 'data.id.record_id' },
        { field: 'web_url', from: 'data.web_url' },
      ],
    },
    {
      id: 'create-company',
      displayName: 'Add a company',
      method: 'POST',
      path: '/v2/objects/companies/records',
      class: 'write',
      params: {
        name: { type: 'string', required: true, at: 'data.values.name', help: 'The company name.' },
        domain: { type: 'string', at: 'data.values.domains.0', help: 'The company website domain, like acme.com.' },
      },
      body: 'json',
      picks: [
        { field: 'record_id', from: 'data.id.record_id' },
        { field: 'web_url', from: 'data.web_url' },
      ],
    },
    {
      id: 'list-people',
      displayName: 'List people',
      method: 'POST',
      path: '/v2/objects/people/records/query',
      class: 'read',
      params: {
        limit: { type: 'number', help: 'How many people to bring back.' },
        offset: { type: 'number', help: 'How many to skip past first.' },
      },
      body: 'json',
      picks: [
        { field: 'record_id', from: 'data.0.id.record_id' },
        { field: 'web_url', from: 'data.0.web_url' },
      ],
    },
    {
      id: 'list-companies',
      displayName: 'List companies',
      method: 'POST',
      path: '/v2/objects/companies/records/query',
      class: 'read',
      params: {
        limit: { type: 'number', help: 'How many companies to bring back.' },
        offset: { type: 'number', help: 'How many to skip past first.' },
      },
      body: 'json',
      picks: [
        { field: 'record_id', from: 'data.0.id.record_id' },
        { field: 'web_url', from: 'data.0.web_url' },
      ],
    },
  ],
  inside: {
    // The app-grain tables where Attio records land.
    tables: [
      {
        name: 'people',
        displayName: 'People',
        rowSchema: {
          'first-name': 'string',
          'last-name': 'string',
          'full-name': 'string',
          'email-address': 'string',
          'record-id': 'string',
          'web-url': 'string',
        },
        grain: 'app',
      },
      {
        name: 'companies',
        displayName: 'Companies',
        rowSchema: {
          name: 'string',
          domain: 'string',
          'record-id': 'string',
          'web-url': 'string',
        },
        grain: 'app',
      },
    ],
    watchers: [],
  },
  settings: [
    { id: 'default_limit', label: 'How many to list', kind: 'number', help: 'Fills the limit on list calls that leave it unset.' },
  ],
  fixtures: [
    {
      endpoint: 'create-person',
      params: { first_name: 'Ada', last_name: 'Lovelace', full_name: 'Ada Lovelace', email_address: 'ada@example.com' },
      status: 200,
      response: {
        data: {
          id: {
            workspace_id: '14beef7a-99f7-4534-a87e-70b564330a4c',
            object_id: '97052eb9-e65e-443f-a297-f2d9a4a7f795',
            record_id: 'bf071e1f-6035-429d-b874-d83ea64ea13b',
          },
          created_at: '2022-11-21T13:22:49.061281000Z',
          web_url: 'https://app.attio.com/salarya/person/bf071e1f-6035-429d-b874-d83ea64ea13b',
          values: {},
        },
      },
    },
    {
      endpoint: 'create-company',
      params: { name: 'Acme Corp', domain: 'acme.com' },
      status: 200,
      response: {
        data: {
          id: {
            workspace_id: '14beef7a-99f7-4534-a87e-70b564330a4c',
            object_id: '3f2ab4c1-9d3e-4b6a-8f21-6a0f4e2d9b77',
            record_id: 'a41edd05-7f2b-49b3-9a10-2e6cf3a1d842',
          },
          created_at: '2022-11-21T13:22:49.061281000Z',
          web_url: 'https://app.attio.com/salarya/company/a41edd05-7f2b-49b3-9a10-2e6cf3a1d842',
          values: {},
        },
      },
    },
    {
      endpoint: 'list-people',
      params: { limit: 3 },
      status: 200,
      response: {
        data: [
          {
            id: {
              workspace_id: '14beef7a-99f7-4534-a87e-70b564330a4c',
              object_id: '97052eb9-e65e-443f-a297-f2d9a4a7f795',
              record_id: 'bf071e1f-6035-429d-b874-d83ea64ea13b',
            },
            created_at: '2022-11-21T13:22:49.061281000Z',
            web_url: 'https://app.attio.com/salarya/person/bf071e1f-6035-429d-b874-d83ea64ea13b',
            values: {
              name: [
                {
                  first_name: 'Ada',
                  last_name: 'Lovelace',
                  full_name: 'Ada Lovelace',
                  attribute_type: 'personal-name',
                },
              ],
            },
          },
        ],
      },
    },
    {
      endpoint: 'list-companies',
      params: { limit: 3 },
      status: 200,
      response: {
        data: [
          {
            id: {
              workspace_id: '14beef7a-99f7-4534-a87e-70b564330a4c',
              object_id: '3f2ab4c1-9d3e-4b6a-8f21-6a0f4e2d9b77',
              record_id: 'a41edd05-7f2b-49b3-9a10-2e6cf3a1d842',
            },
            created_at: '2022-11-21T13:22:49.061281000Z',
            web_url: 'https://app.attio.com/salarya/company/a41edd05-7f2b-49b3-9a10-2e6cf3a1d842',
            values: {
              name: [{ value: 'Acme Corp', attribute_type: 'text' }],
            },
          },
        ],
      },
    },
  ],
};
