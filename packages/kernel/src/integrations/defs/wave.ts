import type { IntegrationDefInput as IntegrationDef } from '../catalog.js';

// Wave accounting integration: GraphQL-only, fixed queries in bodyConstants, params via at-paths into variables.
// Every query nests under business(id); business_id is a required param filled from the Business setting.
// Money.value arrives as a string; the feed's numeric-string coercion lands it in number columns.
export const wave: IntegrationDef = {
  name: 'wave',
  version: 1,
  displayName: 'Wave',
  blurb: 'Read your Wave invoices into your app and add customers back, on your own Wave business.',
  category: 'accounting',
  availability: 'upcoming',
  surfaces: 'both',
  scope: 'builder',
  hosts: ['https://gql.waveapps.com'],
  auth: {
    kind: 'oauth',
    authUrl: 'https://api.waveapps.com/oauth2/authorize/',
    tokenUrl: 'https://api.waveapps.com/oauth2/token/',
    scopes: ['business:read', 'invoice:read', 'customer:write'],
    clientEnv: 'WAVE',
    tokenHelp: 'Click Sign in to Wave and approve access - there is no key to paste. Your business needs an active Wave Pro or Advisor subscription.',
  },
  endpoints: [
    {
      id: 'list-businesses',
      displayName: 'Read your businesses',
      method: 'POST',
      path: '/graphql/public',
      class: 'read',
      // Discovery door: run once, copy the id into the Business setting.
      bodyConstants: {
        query:
          'query Businesses { businesses(page: 1, pageSize: 50) { edges { node { id name } } } }',
      },
      params: {},
      body: 'json',
      picks: [
        { field: 'id', from: 'data.businesses.edges.0.node.id' },
        { field: 'name', from: 'data.businesses.edges.0.node.name' },
      ],
    },
    {
      id: 'list-invoices',
      displayName: 'Read your invoices',
      method: 'POST',
      path: '/graphql/public',
      // A GraphQL read travels as POST but classes as read.
      class: 'read',
      bodyConstants: {
        query:
          'query ListInvoices($businessId: ID!, $page: Int, $pageSize: Int) { business(id: $businessId) { invoices(page: $page, pageSize: $pageSize) { pageInfo { totalCount } edges { node { id invoiceNumber status invoiceDate dueDate viewUrl total { value } amountDue { value } customer { name } } } } } }',
      },
      params: {
        business_id: {
          type: 'string',
          required: true,
          at: 'variables.businessId',
          help: 'Your Wave business id - run Read your businesses once and copy it; the Business setting fills it for every call.',
        },
        page: { type: 'number', at: 'variables.page', help: 'Which page of invoices to read, starting at 1.' },
        page_size: { type: 'number', at: 'variables.pageSize', help: 'How many invoices per page.' },
      },
      body: 'json',
      // Picks land the first invoice; the full list rides the raw response.
      picks: [
        { field: 'id', from: 'data.business.invoices.edges.0.node.id' },
        { field: 'invoice_number', from: 'data.business.invoices.edges.0.node.invoiceNumber' },
        { field: 'status', from: 'data.business.invoices.edges.0.node.status' },
        { field: 'date', from: 'data.business.invoices.edges.0.node.invoiceDate' },
        { field: 'due_date', from: 'data.business.invoices.edges.0.node.dueDate' },
        { field: 'total', from: 'data.business.invoices.edges.0.node.total.value' },
        { field: 'amount_due', from: 'data.business.invoices.edges.0.node.amountDue.value' },
        { field: 'customer', from: 'data.business.invoices.edges.0.node.customer.name' },
        { field: 'url', from: 'data.business.invoices.edges.0.node.viewUrl' },
        { field: 'count', from: 'data.business.invoices.pageInfo.totalCount' },
      ],
    },
    {
      id: 'create-customer',
      displayName: 'Add a customer',
      method: 'POST',
      path: '/graphql/public',
      class: 'write',
      bodyConstants: {
        query:
          'mutation CustomerCreate($businessId: ID!, $name: String!, $email: String, $phone: String) { customerCreate(input: { businessId: $businessId, name: $name, email: $email, phone: $phone }) { didSucceed customer { id name email } } }',
      },
      params: {
        business_id: {
          type: 'string',
          required: true,
          at: 'variables.businessId',
          help: 'Your Wave business id - the Business setting fills this once for every call.',
        },
        name: {
          type: 'string',
          required: true,
          at: 'variables.name',
          help: 'The customer or business name, like Ada Lovelace.',
        },
        email: { type: 'string', at: 'variables.email', help: 'The email address for this customer.' },
        phone: { type: 'string', at: 'variables.phone', help: 'The phone number for this customer.' },
      },
      body: 'json',
      picks: [
        { field: 'success', from: 'data.customerCreate.didSucceed' },
        { field: 'id', from: 'data.customerCreate.customer.id' },
        { field: 'name', from: 'data.customerCreate.customer.name' },
        { field: 'email', from: 'data.customerCreate.customer.email' },
      ],
    },
  ],
  inside: {
    // Mirror pulls once per app; picks land one invoice per pull.
    tables: [
      {
        name: 'invoices',
        displayName: 'Invoices',
        rowSchema: {
          id: 'string',
          'invoice-number': 'string',
          status: 'string',
          date: 'string',
          'due-date': 'string',
          total: 'number',
          'amount-due': 'number',
          customer: 'string',
          url: 'string',
        },
        grain: 'app',
      },
      {
        name: 'customers',
        displayName: 'Customers',
        rowSchema: {
          id: 'string',
          name: 'string',
          email: 'string',
          phone: 'string',
          'business-id': 'string',
        },
        grain: 'app',
      },
    ],
    watchers: [],
  },
  // Invoice read fires hourly per connection; waits until the Business setting is set.
  sync: { endpoint: 'list-invoices', everyMinutes: 60 },
  settings: [
    {
      id: 'business_id',
      label: 'Business',
      kind: 'text',
      help: 'Your Wave business id - run Read your businesses once and copy the id of the business your app works with.',
    },
  ],
  fixtures: [
    {
      endpoint: 'list-businesses',
      params: {},
      status: 200,
      response: {
        data: {
          businesses: {
            edges: [
              { node: { id: 'QnVzaW5lc3M6YWJjMTIz', name: 'Pine and Vine Studio' } },
            ],
          },
        },
      },
    },
    {
      endpoint: 'list-invoices',
      params: { business_id: 'QnVzaW5lc3M6YWJjMTIz', page: 1, page_size: 20 },
      status: 200,
      response: {
        data: {
          business: {
            invoices: {
              pageInfo: { totalCount: 1 },
              edges: [
                {
                  node: {
                    id: 'SW52b2ljZTppbnYxNA',
                    invoiceNumber: '2026-14',
                    status: 'PAID',
                    invoiceDate: '2026-07-01',
                    dueDate: '2026-07-31',
                    viewUrl: 'https://my.waveapps.com/invoice/share/inv14',
                    total: { value: '362.07' },
                    amountDue: { value: '0.00' },
                    customer: { name: 'Sonnenschein Family Store' },
                  },
                },
              ],
            },
          },
        },
      },
    },
    {
      endpoint: 'create-customer',
      params: {
        business_id: 'QnVzaW5lc3M6YWJjMTIz',
        name: 'Ada Lovelace',
        email: 'ada@example.com',
        phone: '(555) 555-5555',
      },
      status: 200,
      response: {
        data: {
          customerCreate: {
            didSucceed: true,
            customer: {
              id: 'Q3VzdG9tZXI6Y3VzMQ',
              name: 'Ada Lovelace',
              email: 'ada@example.com',
            },
          },
        },
      },
    },
  ],
};
