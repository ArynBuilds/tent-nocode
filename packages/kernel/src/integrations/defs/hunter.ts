import type { IntegrationDefInput as IntegrationDef } from '../catalog.js';

export const hunter: IntegrationDef = {
  name: 'hunter',
  version: 1,
  displayName: 'Hunter',
  blurb: 'Find and verify professional email addresses through your own Hunter account.',
  category: 'enrichment',
  surfaces: 'both',
  scope: 'builder',
  hosts: ['https://api.hunter.io'],
  auth: {
    kind: 'query',
    param: 'api_key',
    secretName: 'HUNTER_API_KEY',
    tokenHelp: 'Your API key from the API page of your Hunter dashboard, under hunter.io/api-keys.',
  },
  endpoints: [
    {
      id: 'find-email',
      displayName: 'Find an email address',
      method: 'GET',
      path: '/v2/email-finder',
      class: 'read',
      params: {
        domain: { type: 'string', required: true, help: 'The company website domain, like reddit.com.' },
        first_name: { type: 'string', required: true, help: 'The person\'s first name.' },
        last_name: { type: 'string', required: true, help: 'The person\'s last name.' },
        company: { type: 'string', help: 'The company name, when you have it.' },
      },
      picks: [
        { field: 'email', from: 'data.email' },
        { field: 'score', from: 'data.score' },
        { field: 'position', from: 'data.position' },
        { field: 'verification_status', from: 'data.verification.status' },
      ],
    },
    {
      id: 'verify-email',
      displayName: 'Verify an email address',
      method: 'GET',
      path: '/v2/email-verifier',
      class: 'read',
      params: {
        email: { type: 'string', required: true, help: 'The email address to check.' },
      },
      picks: [
        { field: 'status', from: 'data.status' },
        { field: 'score', from: 'data.score' },
        { field: 'disposable', from: 'data.disposable' },
        { field: 'webmail', from: 'data.webmail' },
        { field: 'accept_all', from: 'data.accept_all' },
      ],
    },
  ],
  inside: {
    tables: [
      {
        name: 'found-emails',
        displayName: 'Found emails',
        rowSchema: {
          domain: 'string',
          'first-name': 'string',
          'last-name': 'string',
          email: 'string',
          score: 'number',
          position: 'string',
          'verification-status': 'string',
        },
        grain: 'app',
      },
      {
        name: 'verified-emails',
        displayName: 'Verified emails',
        rowSchema: {
          email: 'string',
          status: 'string',
          score: 'number',
          disposable: 'boolean',
          webmail: 'boolean',
          'accept-all': 'boolean',
        },
        grain: 'app',
      },
    ],
    watchers: [],
  },
  settings: [
    { id: 'default_domain', label: 'Company domain', kind: 'text', help: 'The domain your app looks up emails on by default.' },
  ],
  fixtures: [
    {
      endpoint: 'find-email',
      params: { domain: 'reddit.com', first_name: 'Alexis', last_name: 'Ohanian' },
      status: 200,
      response: {
        data: {
          first_name: 'Alexis',
          last_name: 'Ohanian',
          email: 'alexis@reddit.com',
          score: 97,
          domain: 'reddit.com',
          accept_all: false,
          position: 'Cofounder',
          company: 'Reddit',
          sources: [
            {
              domain: 'redditblog.com',
              uri: 'http://redditblog.com/2008/10/22/widgets-get-an-upgrade',
              extracted_on: '2018-10-19',
              last_seen_on: '2021-05-18',
              still_on_page: true,
            },
          ],
          verification: { date: '2021-06-14', status: 'valid' },
        },
        meta: {
          params: { first_name: 'Alexis', last_name: 'Ohanian', full_name: null, domain: 'reddit.com', company: null, max_duration: null },
        },
      },
    },
    {
      endpoint: 'verify-email',
      params: { email: 'patrick@stripe.com' },
      status: 200,
      response: {
        data: {
          status: 'valid',
          score: 100,
          email: 'patrick@stripe.com',
          regexp: true,
          gibberish: false,
          disposable: false,
          webmail: false,
          mx_records: true,
          smtp_server: true,
          smtp_check: true,
          accept_all: false,
          block: false,
          sources: [],
        },
        meta: { params: { email: 'patrick@stripe.com' } },
      },
    },
  ],
};
