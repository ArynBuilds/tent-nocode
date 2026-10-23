import type { IntegrationDefInput as IntegrationDef } from '../catalog.js';

// QuickBooks accounting def. realm_id is a required param the owner fills once.
// No fromArray: QuickBooks answers PascalCase keys the feed cannot fill, so picks land the first invoice per pull.
export const quickbooks: IntegrationDef = {
  name: 'quickbooks',
  version: 1,
  displayName: 'QuickBooks',
  blurb: 'Read your QuickBooks invoices into your app and add customers back, on your own QuickBooks company.',
  category: 'accounting',
  availability: 'upcoming',
  surfaces: 'both',
  scope: 'builder',
  hosts: ['https://quickbooks.api.intuit.com'],
  auth: {
    kind: 'oauth',
    authUrl: 'https://appcenter.intuit.com/connect/oauth2',
    tokenUrl: 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer',
    scopes: ['com.intuit.quickbooks.accounting'],
    clientEnv: 'QUICKBOOKS',
    tokenHelp: 'Click Sign in to QuickBooks and approve access to your company - there is no key to paste.',
  },
  // QuickBooks answers XML unless asked; the constant header asks, def-wide.
  headers: { accept: 'application/json' },
  endpoints: [
    {
      id: 'query-invoices',
      displayName: 'Read your invoices',
      method: 'GET',
      path: '/v3/company/{realm_id}/query',
      class: 'read',
      params: {
        realm_id: {
          type: 'string',
          required: true,
          help: 'Your QuickBooks Company ID - in QuickBooks press the gear icon, then Account and settings, Billing and subscription; it is shown at the top.',
        },
        query: {
          type: 'string',
          required: true,
          help: 'What to read, like: select * from Invoice',
        },
      },
      picks: [
        { field: 'id', from: 'QueryResponse.Invoice.0.Id' },
        { field: 'doc_number', from: 'QueryResponse.Invoice.0.DocNumber' },
        { field: 'total', from: 'QueryResponse.Invoice.0.TotalAmt' },
        { field: 'balance', from: 'QueryResponse.Invoice.0.Balance' },
        { field: 'date', from: 'QueryResponse.Invoice.0.TxnDate' },
        { field: 'customer', from: 'QueryResponse.Invoice.0.CustomerRef.name' },
        { field: 'count', from: 'QueryResponse.maxResults' },
      ],
    },
    {
      id: 'create-customer',
      displayName: 'Add a customer',
      method: 'POST',
      path: '/v3/company/{realm_id}/customer',
      class: 'write',
      body: 'json',
      params: {
        realm_id: {
          type: 'string',
          required: true,
          help: 'Your QuickBooks Company ID - the Connect settings fill this once for every call.',
        },
        display_name: {
          type: 'string',
          required: true,
          wire: 'DisplayName',
          help: 'The customer name, unique across your QuickBooks customers, like Ada Lovelace.',
        },
        company_name: {
          type: 'string',
          wire: 'CompanyName',
          help: 'The company this customer belongs to.',
        },
        email: {
          type: 'string',
          at: 'PrimaryEmailAddr.Address',
          help: 'The email address for this customer.',
        },
        phone: {
          type: 'string',
          at: 'PrimaryPhone.FreeFormNumber',
          help: 'The phone number for this customer.',
        },
        notes: {
          type: 'string',
          wire: 'Notes',
          help: 'A note kept on the customer in QuickBooks.',
        },
      },
      picks: [
        { field: 'id', from: 'Customer.Id' },
        { field: 'display_name', from: 'Customer.DisplayName' },
        { field: 'email', from: 'Customer.PrimaryEmailAddr.Address' },
      ],
    },
  ],
  inside: {
    // Accounting mirror pulls once per app; one row per pull from the picks.
    tables: [
      {
        name: 'invoices',
        displayName: 'Invoices',
        rowSchema: {
          id: 'string',
          'doc-number': 'string',
          total: 'number',
          balance: 'number',
          date: 'string',
          customer: 'string',
        },
        grain: 'app',
      },
      {
        name: 'customers',
        displayName: 'Customers',
        rowSchema: {
          id: 'string',
          'display-name': 'string',
          email: 'string',
          phone: 'string',
        },
        grain: 'app',
      },
    ],
    watchers: [],
  },
  // Invoice read fires hourly per active connection; params fill from settings.
  sync: { endpoint: 'query-invoices', everyMinutes: 60 },
  settings: [
    {
      id: 'realm_id',
      label: 'Company ID',
      kind: 'text',
      help: 'In QuickBooks press the gear icon, then Account and settings, Billing and subscription - the Company ID shown at the top.',
    },
    {
      id: 'query',
      label: 'Invoice query',
      kind: 'text',
      help: 'What the mirror pulls on every sync, like: select * from Invoice',
    },
  ],
  fixtures: [
    {
      endpoint: 'query-invoices',
      params: { realm_id: '9341453908433', query: 'select * from Invoice' },
      status: 200,
      response: {
        QueryResponse: {
          Invoice: [
            {
              Id: '130',
              SyncToken: '0',
              DocNumber: '1070',
              TxnDate: '2026-07-24',
              DueDate: '2026-08-23',
              TotalAmt: 362.07,
              Balance: 0,
              CustomerRef: { value: '24', name: 'Sonnenschein Family Store' },
              CurrencyRef: { value: 'USD', name: 'United States Dollar' },
              Line: [
                {
                  Id: '1',
                  LineNum: 1,
                  Amount: 362.07,
                  DetailType: 'SalesItemLineDetail',
                  SalesItemLineDetail: {
                    ItemRef: { value: '5', name: 'Rock Fountain' },
                    Qty: 1,
                  },
                },
              ],
              domain: 'QBO',
              sparse: false,
            },
          ],
          startPosition: 1,
          maxResults: 1,
        },
        time: '2026-08-15T10:30:05.985-07:00',
      },
    },
    {
      endpoint: 'create-customer',
      params: {
        realm_id: '9341453908433',
        display_name: "King's Groceries",
        email: 'jdrew@myemail.com',
        phone: '(555) 555-5555',
      },
      status: 200,
      response: {
        Customer: {
          Id: '67',
          SyncToken: '0',
          DisplayName: "King's Groceries",
          FullyQualifiedName: "King's Groceries",
          PrintOnCheckName: "King's Groceries",
          PrimaryEmailAddr: { Address: 'jdrew@myemail.com' },
          PrimaryPhone: { FreeFormNumber: '(555) 555-5555' },
          Taxable: true,
          Active: true,
          Balance: 0,
          BalanceWithJobs: 0,
          CurrencyRef: { value: 'USD', name: 'United States Dollar' },
          Job: false,
          BillWithParent: false,
          MetaData: {
            CreateTime: '2026-08-15T10:30:00-07:00',
            LastUpdatedTime: '2026-08-15T10:30:00-07:00',
          },
          domain: 'QBO',
          sparse: false,
        },
        time: '2026-08-15T10:30:05.985-07:00',
      },
    },
  ],
};
