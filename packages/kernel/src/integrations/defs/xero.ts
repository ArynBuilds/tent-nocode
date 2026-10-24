// Xero accounting connector: mirror invoices in, create contacts out.
// Every accounting call needs a per-connection xero-tenant-id header the current header grammar cannot carry.
// Xero answers PascalCase keys, so the invoices mirror stays empty until a case-fold widening lands.
import type { IntegrationDefInput as IntegrationDef } from '../catalog.js';

export const xero: IntegrationDef = {
  name: 'xero',
  version: 1,
  displayName: 'Xero',
  blurb: 'Bring invoices from your own Xero into your app and add contacts to it from your app.',
  category: 'accounting',
  surfaces: 'both',
  scope: 'builder',
  // Waits on the Nodeloom Xero app registration.
  availability: 'upcoming',
  hosts: ['https://api.xero.com'],
  auth: {
    kind: 'oauth',
    authUrl: 'https://login.xero.com/identity/connect/authorize',
    tokenUrl: 'https://identity.xero.com/connect/token',
    scopes: ['accounting.transactions', 'accounting.contacts', 'offline_access'],
    clientEnv: 'XERO',
    tokenHelp: 'Click Sign in to Xero and approve access - Nodeloom holds the sign-in, you never paste a key.',
  },
  // The accounting API answers XML by default; this asks for JSON on every call.
  headers: { accept: 'application/json' },
  endpoints: [
    {
      id: 'list-invoices',
      displayName: 'List your invoices',
      method: 'GET',
      path: '/api.xro/2.0/Invoices',
      class: 'read',
      params: {
        // Xero speaks PascalCase query names; `wire` carries the casing.
        statuses: {
          type: 'string',
          wire: 'Statuses',
          help: 'Only invoices in these states, comma-separated - like AUTHORISED,PAID; leave unset for all.',
        },
        page: { type: 'number', help: 'Which page of up to 100 invoices to return, starting at 1.' },
      },
      // Snake-named projections of the PascalCase answer.
      picks: [
        { field: 'invoice_id', from: 'Invoices.0.InvoiceID' },
        { field: 'invoice_number', from: 'Invoices.0.InvoiceNumber' },
        { field: 'contact', from: 'Invoices.0.Contact.Name' },
        { field: 'status', from: 'Invoices.0.Status' },
        { field: 'total', from: 'Invoices.0.Total' },
        { field: 'amount_due', from: 'Invoices.0.AmountDue' },
        { field: 'currency_code', from: 'Invoices.0.CurrencyCode' },
      ],
    },
    {
      id: 'create-contact',
      displayName: 'Add a contact',
      method: 'POST',
      path: '/api.xro/2.0/Contacts',
      class: 'write',
      body: 'json',
      params: {
        // The create body nests Contacts as an array; numeric at-path segments mint it.
        name: { type: 'string', required: true, at: 'Contacts.0.Name', help: 'The contact name, like ABC Limited - Xero requires it.' },
        first_name: { type: 'string', at: 'Contacts.0.FirstName', help: 'The first name of the person.' },
        last_name: { type: 'string', at: 'Contacts.0.LastName', help: 'The last name of the person.' },
        email: { type: 'string', at: 'Contacts.0.EmailAddress', help: 'The email address for this contact.' },
      },
      picks: [
        { field: 'contact_id', from: 'Contacts.0.ContactID' },
        { field: 'contact_status', from: 'Contacts.0.ContactStatus' },
      ],
    },
  ],
  inside: {
    tables: [
      {
        // One row per invoice, app grain; stays empty until the case-fold widening lands.
        name: 'invoices',
        displayName: 'Invoices',
        rowSchema: {
          'invoice-id': 'string',
          'invoice-number': 'string',
          status: 'string',
          total: 'number',
          'amount-due': 'number',
          'currency-code': 'string',
        },
        grain: 'app',
        fromArray: 'Invoices',
      },
      {
        // Fills by name from the snake params plus the contact_id pick.
        name: 'added-contacts',
        displayName: 'Added contacts',
        rowSchema: {
          'contact-id': 'string',
          name: 'string',
          'first-name': 'string',
          'last-name': 'string',
          email: 'string',
        },
        grain: 'app',
      },
    ],
    watchers: [],
  },
  settings: [
    // The xero-tenant-id value; inert until headers can fill from settings.
    {
      id: 'tenant_id',
      label: 'Organisation',
      kind: 'text',
      help: 'Which Xero organisation this connection acts in - filled after sign-in once organisation capture lands.',
    },
    // default_<param> fills the statuses param when the caller left it unset.
    {
      id: 'default_statuses',
      label: 'Invoice states',
      kind: 'text',
      help: 'Which invoices the mirror pulls, comma-separated - like AUTHORISED,PAID; leave unset for all.',
    },
  ],
  // The invoices mirror refreshes hourly per active connection.
  sync: { endpoint: 'list-invoices', everyMinutes: 60 },
  fixtures: [
    {
      endpoint: 'list-invoices',
      params: { statuses: 'AUTHORISED,PAID', page: 1 },
      status: 200,
      response: {
        Id: '900c500b-e83c-4ce2-902a-b8ba04751748',
        Status: 'OK',
        ProviderName: 'Nodeloom',
        DateTimeUTC: '/Date(1755235200000)/',
        Invoices: [
          {
            Type: 'ACCREC',
            InvoiceID: '243216c5-369e-4056-ac67-05388f86dc81',
            InvoiceNumber: 'OIT00546',
            Reference: '',
            Contact: { ContactID: '6d42f03b-181f-43e3-93fb-2025c012de92', Name: 'Martin Hudson' },
            DateString: '2026-08-01T00:00:00',
            DueDateString: '2026-08-15T00:00:00',
            Status: 'AUTHORISED',
            LineAmountTypes: 'Exclusive',
            SubTotal: 250.0,
            TotalTax: 37.5,
            Total: 287.5,
            AmountDue: 287.5,
            AmountPaid: 0.0,
            CurrencyCode: 'NZD',
            UpdatedDateUTC: '/Date(1755235100000)/',
          },
          {
            Type: 'ACCREC',
            InvoiceID: '8694c9c5-7097-4449-a708-b8c1982921a4',
            InvoiceNumber: 'OIT00542',
            Reference: 'Website design',
            Contact: { ContactID: '3ff6d40c-af9a-40a3-89ce-3c1556a25591', Name: 'ABC Limited' },
            DateString: '2026-07-20T00:00:00',
            DueDateString: '2026-08-03T00:00:00',
            Status: 'PAID',
            LineAmountTypes: 'Exclusive',
            SubTotal: 1000.0,
            TotalTax: 150.0,
            Total: 1150.0,
            AmountDue: 0.0,
            AmountPaid: 1150.0,
            CurrencyCode: 'NZD',
            UpdatedDateUTC: '/Date(1754540000000)/',
          },
        ],
      },
    },
    {
      endpoint: 'create-contact',
      params: { name: 'ABC Limited', first_name: 'Andrea', last_name: 'Dutchess', email: 'a.dutchess@abclimited.com' },
      status: 200,
      response: {
        Id: 'e3626c45-77f1-4ab0-ba9b-3593c7bcd25c',
        Status: 'OK',
        ProviderName: 'Nodeloom',
        DateTimeUTC: '/Date(1755235300000)/',
        Contacts: [
          {
            ContactID: '3ff6d40c-af9a-40a3-89ce-3c1556a25591',
            ContactStatus: 'ACTIVE',
            Name: 'ABC Limited',
            FirstName: 'Andrea',
            LastName: 'Dutchess',
            EmailAddress: 'a.dutchess@abclimited.com',
            Addresses: [],
            Phones: [],
            UpdatedDateUTC: '/Date(1755235300000)/',
            IsSupplier: false,
            IsCustomer: false,
          },
        ],
      },
    },
  ],
};
