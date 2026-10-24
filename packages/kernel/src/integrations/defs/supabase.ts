import type { IntegrationDefInput as IntegrationDef } from '../catalog.js';

// Supabase import door: reads PostgREST rows with offset paging and recreates each table locally.
export const supabase: IntegrationDef = {
  name: 'supabase',
  version: 1,
  displayName: 'Supabase',
  blurb: 'Bring your Supabase tables into Nodeloom - an import recreates each table with its own columns.',
  category: 'backend',
  surfaces: 'both',
  scope: 'builder',
  hosts: { template: 'https://{ref}.supabase.co', slot: 'ref' },
  auth: {
    kind: 'header',
    header: 'apikey',
    secretName: 'SUPABASE_SERVICE_KEY',
    tokenHelp: 'Under Project Settings, API, copy the service_role key (imports read every row). The project ref is the 20-character code in your project URL. If your Max Rows setting sits below 1000, raise it before importing - a lowered cap silently shortens every page.',
  },
  endpoints: [
    {
      id: 'read-rows',
      displayName: 'Read rows from a table',
      method: 'GET',
      path: '/rest/v1/{table_name}',
      class: 'read',
      params: {
        table_name: { type: 'string', required: true, help: 'The table to read, exactly as named in Supabase.' },
        limit: { type: 'number', help: 'How many rows per pull.' },
        offset: { type: 'number', help: 'How many rows to skip - the import pages with this.' },
      },
    },
  ],
  inside: { tables: [], watchers: [] },
  importDoor: {
    endpoint: 'read-rows',
    // '.' means the response body itself is the rows array.
    fromArray: '.',
    keyColumn: 'id',
    page: { kind: 'offset', param: 'offset', size: 1000 },
  },
  settings: [
    { id: 'table_name', label: 'Table', kind: 'text', help: 'The Supabase table an import brings in.' },
  ],
  fixtures: [
    {
      endpoint: 'read-rows',
      params: { table_name: 'customers', limit: 2, offset: 0 },
      status: 200,
      response: [
        { id: 1, name: 'Ada', email: 'ada@example.com', active: true },
        { id: 2, name: 'Grace', email: 'grace@example.com', active: false },
      ],
    },
  ],
};
