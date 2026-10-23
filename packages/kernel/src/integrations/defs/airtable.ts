import type { IntegrationDefInput as IntegrationDef } from '../catalog.js';

// Airtable Web API: one base's table mirrored in, records created out; the mirror carries record ids only since cell values nest under per-record fields.
export const airtable: IntegrationDef = {
  name: 'airtable',
  version: 1,
  displayName: 'Airtable',
  blurb: 'Mirror an Airtable table into your app and add records to it from your own account.',
  category: 'productivity',
  surfaces: 'both',
  scope: 'builder',
  hosts: ['https://api.airtable.com'],
  auth: {
    kind: 'bearer',
    secretName: 'AIRTABLE_TOKEN',
    tokenHelp:
      'Create a personal access token at airtable.com/create/tokens with the data.records read and write scopes, and grant it access to the base you want to connect.',
  },
  endpoints: [
    {
      id: 'list-records',
      displayName: 'Read records from a table',
      method: 'GET',
      path: '/v0/{base_id}/{table}',
      class: 'read',
      params: {
        base_id: {
          type: 'string',
          required: true,
          help: 'The base ID, starting with app - shown in the base URL and on airtable.com/developers when you pick the base.',
        },
        table: {
          type: 'string',
          required: true,
          help: 'The table name (like Tasks) or its ID starting with tbl.',
        },
        view: {
          type: 'string',
          help: 'A view name or ID - only records visible in that view come back.',
        },
        max_records: {
          type: 'number',
          wire: 'maxRecords',
          help: 'Stop after this many records. One call returns at most 100.',
        },
        offset: {
          type: 'string',
          help: 'The paging cursor from the last answer - the import pages with this.',
        },
      },
    },
    {
      id: 'create-record',
      displayName: 'Add a record',
      method: 'POST',
      path: '/v0/{base_id}/{table}',
      class: 'write',
      params: {
        base_id: {
          type: 'string',
          required: true,
          help: 'The base ID, starting with app.',
        },
        table: {
          type: 'string',
          required: true,
          help: 'The table name (like Tasks) or its ID starting with tbl.',
        },
        name: {
          type: 'string',
          required: true,
          at: 'fields.Name',
          help: 'Lands in the column named Name - the primary column of a fresh Airtable table. Rename yours to Name if it differs.',
        },
        notes: {
          type: 'string',
          at: 'fields.Notes',
          help: 'Lands in the column named Notes, if your table has one.',
        },
      },
      body: 'json',
      picks: [{ field: 'id', from: 'id' }],
    },
  ],
  inside: {
    // One row per record; the record id is the only column that can land by top-level name.
    tables: [
      {
        name: 'records',
        displayName: 'Records',
        rowSchema: { id: 'string' },
        grain: 'app',
        fromArray: 'records',
      },
    ],
    watchers: [],
  },
  settings: [
    {
      id: 'base_id',
      label: 'Base',
      kind: 'text',
      help: 'The base ID, starting with app - the mirror and new records use this base.',
    },
    {
      id: 'table',
      label: 'Table',
      kind: 'text',
      help: 'The table name or ID inside that base.',
    },
  ],
  // Mirror sync: base_id and table fill from the settings above.
  sync: { endpoint: 'list-records', everyMinutes: 30 },
  // Import: elementAt folds each record's fields into the row beside its id; Airtable pages with an offset cursor.
  importDoor: {
    endpoint: 'list-records',
    fromArray: 'records',
    elementAt: 'fields',
    keyColumn: 'id',
    page: { kind: 'cursor', pick: 'offset', param: 'offset' },
  },
  // The id-only rowSchema means an edited record never changes its row, so only fresh records fire.
  triggers: [
    { kind: 'poll', id: 'record-added', displayName: 'Record added', table: 'records' },
  ],
  fixtures: [
    {
      endpoint: 'list-records',
      params: { base_id: 'applkNDICXNqxSDhG', table: 'Tasks' },
      status: 200,
      response: {
        records: [
          {
            id: 'rec560UJdUtocSouk',
            createdTime: '2022-09-12T21:03:48.000Z',
            fields: { Name: 'Union Square', Notes: 'Check the north corner', Visited: true },
          },
          {
            id: 'rec3lbPRG4aVqkeOQ',
            createdTime: '2022-09-12T21:03:48.000Z',
            fields: { Name: 'Ferry Building' },
          },
        ],
      },
    },
    {
      endpoint: 'create-record',
      params: {
        base_id: 'applkNDICXNqxSDhG',
        table: 'Tasks',
        name: 'Union Square',
        notes: 'Check the north corner',
      },
      status: 200,
      response: {
        id: 'rec560UJdUtocSouk',
        createdTime: '2022-09-12T21:03:48.000Z',
        fields: { Name: 'Union Square', Notes: 'Check the north corner' },
      },
    },
  ],
};
