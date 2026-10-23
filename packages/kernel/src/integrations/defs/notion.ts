import type { IntegrationDefInput as IntegrationDef } from '../catalog.js';

// Notion integration def: mirror a database into a Table and add pages via internal-integration token.
// Notion-Version pinned to 2022-06-28; the mirror carries page identity only - property values nest under user-named keys the flat fill cannot reach.
export const notion: IntegrationDef = {
  name: 'notion',
  version: 1,
  displayName: 'Notion',
  blurb: 'Mirror a Notion database into a Table and add pages to it from your app.',
  category: 'productivity',
  surfaces: 'both',
  scope: 'builder',
  hosts: ['https://api.notion.com'],
  auth: {
    kind: 'bearer',
    secretName: 'NOTION_API_TOKEN',
    tokenHelp:
      'Create an internal integration at notion.so/my-integrations and copy its Internal Integration Secret. Then open your database in Notion and connect the integration to it through the page menu, under Connections.',
  },
  headers: {
    'notion-version': '2022-06-28',
  },
  endpoints: [
    {
      id: 'query-database',
      displayName: 'Read a database',
      method: 'POST',
      path: '/v1/databases/{database_id}/query',
      class: 'read',
      body: 'json',
      params: {
        database_id: {
          type: 'string',
          required: true,
          help: 'The database ID from its Notion link - the 32-character part before any question mark.',
        },
        page_size: {
          type: 'number',
          help: 'How many pages to read per pull, up to 100.',
        },
        start_cursor: {
          type: 'string',
          help: 'The paging cursor from the last answer - the import pages with this.',
        },
      },
      picks: [{ field: 'next_cursor', from: 'next_cursor' }],
    },
    {
      id: 'create-page',
      displayName: 'Add a page',
      method: 'POST',
      path: '/v1/pages',
      class: 'write',
      body: 'json',
      params: {
        database_id: {
          type: 'string',
          required: true,
          at: 'parent.database_id',
          help: 'The database the page lands in - the 32-character ID from its Notion link.',
        },
        title: {
          type: 'string',
          required: true,
          at: 'properties.Name.title.0.text.content',
          help: 'The page title. Assumes the database title column is named Name, the Notion default - this def writes the title alone.',
        },
      },
      picks: [
        { field: 'id', from: 'id' },
        { field: 'url', from: 'url' },
        { field: 'created_time', from: 'created_time' },
      ],
    },
  ],
  inside: {
    // One row per page in the picked database.
    tables: [
      {
        name: 'pages',
        displayName: 'Pages',
        rowSchema: {
          id: 'string',
          url: 'string',
          'created-time': 'string',
          'last-edited-time': 'string',
        },
        grain: 'app',
        fromArray: 'results',
      },
    ],
    watchers: [],
  },
  // The database_id setting fills the required param on each sync pull.
  sync: { endpoint: 'query-database', everyMinutes: 30 },
  // Imports page identity rows, paged with Notion's next_cursor.
  importDoor: {
    endpoint: 'query-database',
    fromArray: 'results',
    keyColumn: 'id',
    page: { kind: 'cursor', pick: 'next_cursor', param: 'start_cursor' },
  },
  settings: [
    {
      id: 'database_id',
      label: 'Database',
      kind: 'text',
      help: 'The Notion database this node mirrors and adds pages to - the 32-character ID from its link. Remember to connect your integration to it in Notion.',
    },
  ],
  // Poll trigger: fires per fresh row in the mirrored pages table.
  triggers: [
    { kind: 'poll', id: 'page-changed', displayName: 'Page added or changed', table: 'pages' },
  ],
  fixtures: [
    {
      endpoint: 'query-database',
      params: { database_id: 'd9824bdc84454327be8b5b47500af6ce', page_size: 2 },
      status: 200,
      response: {
        object: 'list',
        results: [
          {
            object: 'page',
            id: '59833787-2cf9-4fdf-8782-e53db20768a5',
            created_time: '2026-03-01T19:05:00.000Z',
            last_edited_time: '2026-07-06T20:25:00.000Z',
            url: 'https://www.notion.so/Tuscan-kale-598337872cf94fdf8782e53db20768a5',
            properties: {
              Name: {
                id: 'title',
                type: 'title',
                title: [{ type: 'text', text: { content: 'Tuscan kale' }, plain_text: 'Tuscan kale' }],
              },
            },
          },
          {
            object: 'page',
            id: '7c6b1c95-de50-45ca-94e6-af1d9fd295ab',
            created_time: '2026-04-14T09:12:00.000Z',
            last_edited_time: '2026-04-14T09:12:00.000Z',
            url: 'https://www.notion.so/Winter-squash-7c6b1c95de5045ca94e6af1d9fd295ab',
            properties: {
              Name: {
                id: 'title',
                type: 'title',
                title: [{ type: 'text', text: { content: 'Winter squash' }, plain_text: 'Winter squash' }],
              },
            },
          },
        ],
        next_cursor: null,
        has_more: false,
      },
    },
    {
      endpoint: 'create-page',
      params: { database_id: 'd9824bdc84454327be8b5b47500af6ce', title: 'Tuscan kale' },
      status: 200,
      response: {
        object: 'page',
        id: '59833787-2cf9-4fdf-8782-e53db20768a5',
        created_time: '2026-08-15T19:10:04.535Z',
        last_edited_time: '2026-08-15T19:10:04.535Z',
        parent: { type: 'database_id', database_id: 'd9824bdc-8445-4327-be8b-5b47500af6ce' },
        url: 'https://www.notion.so/Tuscan-kale-598337872cf94fdf8782e53db20768a5',
        properties: {
          Name: {
            id: 'title',
            type: 'title',
            title: [{ type: 'text', text: { content: 'Tuscan kale' }, plain_text: 'Tuscan kale' }],
          },
        },
      },
    },
  ],
};
