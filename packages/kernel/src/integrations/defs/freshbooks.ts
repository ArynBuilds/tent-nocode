import type { IntegrationDefInput as IntegrationDef } from '../catalog.js';

// FreshBooks invoice reads + client create; account_id is a required path param the owner fills once as a setting, and nested money objects stay out of the mirror.
export const freshbooks: IntegrationDef = {
  name: 'freshbooks',
  version: 1,
  displayName: 'FreshBooks',
  blurb: 'Read your FreshBooks invoices into your app and add clients back, on your own FreshBooks account.',
  category: 'accounting',
  availability: 'upcoming',
  surfaces: 'both',
  scope: 'builder',
  hosts: ['https://api.freshbooks.com'],
  auth: {
    kind: 'oauth',
    authUrl: 'https://auth.freshbooks.com/oauth/authorize',
    tokenUrl: 'https://api.freshbooks.com/auth/oauth/token',
    // FreshBooks fixes scopes on the app at registration; this list doubles as the registration checklist.
    scopes: ['user:profile:read', 'user:invoices:read', 'user:clients:write'],
    clientEnv: 'FRESHBOOKS',
    tokenHelp: 'Click Sign in to FreshBooks and approve access to your account - there is no key to paste.',
  },
  endpoints: [
    {
      id: 'list-invoices',
      displayName: 'Read your invoices',
      method: 'GET',
      path: '/accounting/account/{account_id}/invoices/invoices',
      class: 'read',
      params: {
        account_id: {
          type: 'string',
          required: true,
          help: 'Your FreshBooks Account ID - the short letter code (like zDmNq) shown in your FreshBooks web address after you log in.',
        },
      },
      picks: [
        { field: 'total', from: 'response.result.total' },
        { field: 'page', from: 'response.result.page' },
        { field: 'pages', from: 'response.result.pages' },
      ],
    },
    {
      id: 'create-client',
      displayName: 'Add a client',
      method: 'POST',
      path: '/accounting/account/{account_id}/users/clients',
      class: 'write',
      body: 'json',
      params: {
        account_id: {
          type: 'string',
          required: true,
          help: 'Your FreshBooks Account ID - the Connect settings fill this once for every call.',
        },
        email: {
          type: 'string',
          required: true,
          at: 'client.email',
          help: 'The email address for this client.',
        },
        first_name: {
          type: 'string',
          at: 'client.fname',
          help: 'The client first name.',
        },
        last_name: {
          type: 'string',
          at: 'client.lname',
          help: 'The client last name.',
        },
        organization: {
          type: 'string',
          at: 'client.organization',
          help: 'The company this client belongs to.',
        },
      },
      picks: [
        { field: 'id', from: 'response.result.client.id' },
        { field: 'email', from: 'response.result.client.email' },
        { field: 'organization', from: 'response.result.client.organization' },
      ],
    },
  ],
  inside: {
    // Mirror pulls once per app; one row per invoice, money columns stay out.
    tables: [
      {
        name: 'invoices',
        displayName: 'Invoices',
        fromArray: 'response.result.invoices',
        rowSchema: {
          id: 'number',
          'invoice-number': 'string',
          organization: 'string',
          'create-date': 'string',
          'due-date': 'string',
          'payment-status': 'string',
          'currency-code': 'string',
        },
        grain: 'app',
      },
      {
        name: 'clients',
        displayName: 'Clients',
        rowSchema: {
          id: 'number',
          'first-name': 'string',
          'last-name': 'string',
          email: 'string',
          organization: 'string',
        },
        grain: 'app',
      },
    ],
    watchers: [],
  },
  // Invoice read fires hourly; waits until the account_id setting is filled.
  sync: { endpoint: 'list-invoices', everyMinutes: 60 },
  settings: [
    {
      id: 'account_id',
      label: 'Account ID',
      kind: 'text',
      help: 'The short letter code (like zDmNq) in your FreshBooks web address after you log in - it fills every call and the invoice mirror.',
    },
  ],
  fixtures: [
    {
      endpoint: 'list-invoices',
      params: { account_id: 'zDmNq' },
      status: 200,
      response: {
        response: {
          result: {
            invoices: [
              {
                id: 324,
                invoiceid: 324,
                accountid: 'zDmNq',
                invoice_number: '0000007',
                customerid: 806,
                organization: 'First1 Last1',
                fname: 'First1',
                lname: 'Last1',
                create_date: '2026-07-05',
                due_date: '2026-07-05',
                status: 1,
                v3_status: 'draft',
                display_status: 'draft',
                payment_status: 'unpaid',
                currency_code: 'CAD',
                amount: { amount: '104.50', code: 'CAD' },
                outstanding: { amount: '104.50', code: 'CAD' },
                paid: { amount: '0.00', code: 'CAD' },
              },
            ],
            page: 1,
            pages: 1,
            per_page: 15,
            total: 1,
          },
        },
      },
    },
    {
      endpoint: 'create-client',
      params: {
        account_id: 'zDmNq',
        email: 'gordon.shumway@AmericanCyanamid.com',
        first_name: 'Gordon',
        last_name: 'Shumway',
        organization: 'American Cyanamid',
      },
      status: 200,
      response: {
        response: {
          result: {
            client: {
              id: 238950,
              userid: 238950,
              fname: 'Gordon',
              lname: 'Shumway',
              email: 'gordon.shumway@AmericanCyanamid.com',
              organization: 'American Cyanamid',
              accounting_systemid: 'zDmNq',
              currency_code: 'USD',
              updated: '2026-08-15 10:30:00',
            },
          },
        },
      },
    },
  ],
};
