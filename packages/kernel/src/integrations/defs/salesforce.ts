// Salesforce CRM def: SOQL mirror-in plus contact create-out.
// Salesforce answers PascalCase keys the exact-case feed cannot fill, so the contacts mirror lands empty for now.
import type { IntegrationDefInput as IntegrationDef } from '../catalog.js';

export const salesforce: IntegrationDef = {
  name: 'salesforce',
  version: 1,
  displayName: 'Salesforce',
  blurb: 'Bring records from your own Salesforce into your app and add new contacts from it.',
  category: 'crm',
  surfaces: 'both',
  scope: 'builder',
  // Upcoming: the vendor app is not registered yet, so the Connect card waits.
  availability: 'upcoming',
  // Every REST call anchors on the org's own My Domain; the suffix stays def-declared.
  hosts: { template: 'https://{instance}.my.salesforce.com', slot: 'instance' },
  auth: {
    kind: 'oauth',
    authUrl: 'https://login.salesforce.com/services/oauth2/authorize',
    tokenUrl: 'https://login.salesforce.com/services/oauth2/token',
    scopes: ['api', 'refresh_token'],
    clientEnv: 'SALESFORCE',
    tokenHelp: 'Click Sign in to Salesforce and approve access - Nodeloom holds the sign-in, you never paste a key.',
  },
  endpoints: [
    {
      id: 'soql-query',
      displayName: 'Look up records',
      method: 'GET',
      path: '/services/data/v61.0/query',
      class: 'read',
      params: {
        q: {
          type: 'string',
          required: true,
          help: 'What to pull, in Salesforce query words - like SELECT Id, FirstName, LastName, Email FROM Contact.',
        },
      },
      picks: [
        { field: 'total', from: 'totalSize' },
        { field: 'done', from: 'done' },
      ],
    },
    {
      id: 'create-contact',
      displayName: 'Add a contact',
      method: 'POST',
      path: '/services/data/v61.0/sobjects/Contact',
      class: 'write',
      body: 'json',
      params: {
        // Salesforce speaks PascalCase on the wire; `wire` carries the casing.
        last_name: { type: 'string', required: true, wire: 'LastName', help: 'The last name - Salesforce requires it.' },
        first_name: { type: 'string', wire: 'FirstName', help: 'The first name.' },
        email: { type: 'string', wire: 'Email', help: 'The email address for this contact.' },
        phone: { type: 'string', wire: 'Phone', help: 'The phone number for this contact.' },
        title: { type: 'string', wire: 'Title', help: 'What this person does, like Head of Sales.' },
      },
      picks: [
        { field: 'id', from: 'id' },
        { field: 'success', from: 'success' },
      ],
    },
  ],
  inside: {
    tables: [
      {
        // Mirror-in: one row per queried record; stays empty until case-fold matching lands.
        name: 'contacts',
        displayName: 'Contacts',
        rowSchema: {
          id: 'string',
          'first-name': 'string',
          'last-name': 'string',
          email: 'string',
          phone: 'string',
        },
        grain: 'app',
        fromArray: 'records',
      },
      {
        // Create-out log: fills from our own params plus the lowercase id the create answers.
        name: 'added-contacts',
        displayName: 'Added contacts',
        rowSchema: {
          id: 'string',
          'first-name': 'string',
          'last-name': 'string',
          email: 'string',
          phone: 'string',
        },
        grain: 'app',
      },
    ],
    watchers: [],
  },
  settings: [
    // Named like the read endpoint's q param, so it fills q when unset.
    {
      id: 'q',
      label: 'What to pull',
      kind: 'text',
      help: 'The Salesforce query the mirror runs, like SELECT Id, FirstName, LastName, Email FROM Contact.',
    },
  ],
  // Contacts mirror refreshes hourly per active connection.
  sync: { endpoint: 'soql-query', everyMinutes: 60 },
  // Trigger row: a poll over the contacts mirror.
  triggers: [
    { kind: 'poll', id: 'contact-changed', displayName: 'Contact added or changed', table: 'contacts' },
  ],
  fixtures: [
    {
      // Query answers { totalSize, done, records } with PascalCase fields.
      endpoint: 'soql-query',
      params: { q: 'SELECT Id, FirstName, LastName, Email FROM Contact' },
      status: 200,
      response: {
        totalSize: 2,
        done: true,
        records: [
          {
            attributes: { type: 'Contact', url: '/services/data/v61.0/sobjects/Contact/003R00000025REKIA2' },
            Id: '003R00000025REKIA2',
            FirstName: 'Sean',
            LastName: 'Forbes',
            Email: 'sean@example.com',
          },
          {
            attributes: { type: 'Contact', url: '/services/data/v61.0/sobjects/Contact/003R00000025RELIA2' },
            Id: '003R00000025RELIA2',
            FirstName: 'Ada',
            LastName: 'Lovelace',
            Email: 'ada@example.com',
          },
        ],
      },
    },
    {
      // Creation answers 201 with { id, success, errors }; lowercase id on the way back.
      endpoint: 'create-contact',
      params: { last_name: 'Forbes', first_name: 'Sean', email: 'sean@example.com', phone: '+1 415 555 0100' },
      status: 201,
      response: { id: '003R00000025REKIA2', success: true, errors: [] },
    },
  ],
};
