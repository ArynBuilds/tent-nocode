import type { IntegrationDefInput as IntegrationDef } from '../catalog.js';

// monday.com integration def: GraphQL-only API - one POST /v2 door; queries ride bodyConstants, params map into variables via `at`.
export const monday: IntegrationDef = {
  name: 'monday',
  version: 1,
  displayName: 'monday.com',
  blurb: 'Read your monday.com board items and create new ones from your app.',
  category: 'data',
  surfaces: 'both',
  scope: 'builder',
  hosts: ['https://api.monday.com'],
  auth: {
    kind: 'header',
    header: 'authorization',
    secretName: 'MONDAY_API_TOKEN',
    tokenHelp: 'Create a personal API token under Developers, My access tokens in your monday.com account.',
  },
  headers: { 'api-version': '2026-07' },
  endpoints: [
    {
      id: 'create-item',
      displayName: 'Create an item',
      method: 'POST',
      path: '/v2',
      class: 'write',
      bodyConstants: {
        query:
          'mutation ($board_id: ID!, $item_name: String!, $group_id: String, $column_values: JSON) { create_item (board_id: $board_id, item_name: $item_name, group_id: $group_id, column_values: $column_values) { id name } }',
      },
      params: {
        board_id: { type: 'string', required: true, at: 'variables.board_id', help: 'The board the item lands on.' },
        item_name: { type: 'string', required: true, at: 'variables.item_name', help: 'The name of the new item.' },
        group_id: { type: 'string', at: 'variables.group_id', help: 'The group inside the board, if not the default group.' },
        column_values: { type: 'string', at: 'variables.column_values', help: 'Column data as a JSON string, like {"date":"2026-08-15"}.' },
      },
      body: 'json',
      picks: [{ field: 'item_id', from: 'data.create_item.id' }],
    },
    {
      id: 'items-read',
      displayName: 'Read board items',
      method: 'POST',
      path: '/v2',
      class: 'read',
      bodyConstants: {
        query:
          'query ($board_id: ID!, $limit: Int) { boards (ids: [$board_id]) { items_page (limit: $limit) { cursor items { id name } } } }',
      },
      params: {
        board_id: { type: 'string', required: true, at: 'variables.board_id', help: 'The board to read items from.' },
        limit: { type: 'number', at: 'variables.limit', help: 'How many items per pull, up to 500.' },
      },
      body: 'json',
      picks: [
        { field: 'item_id', from: 'data.boards.0.items_page.items.0.id' },
        { field: 'item_name', from: 'data.boards.0.items_page.items.0.name' },
        { field: 'cursor', from: 'data.boards.0.items_page.cursor' },
      ],
    },
  ],
  inside: {
    // Board items land here; kebab columns fill from their snake_case twins.
    tables: [
      {
        name: 'items',
        displayName: 'Items',
        rowSchema: { 'item-id': 'string', 'item-name': 'string', 'board-id': 'string' },
        grain: 'app',
      },
    ],
    watchers: [],
  },
  settings: [
    { id: 'default_board_id', label: 'Board', kind: 'text', help: 'The board id your app reads and creates in by default.' },
  ],
  fixtures: [
    {
      endpoint: 'create-item',
      params: { board_id: '1234567890', item_name: 'new item', group_id: 'group_one', column_values: '{"date":"2023-05-25"}' },
      status: 200,
      response: { data: { create_item: { id: '1234567895', name: 'new item' } } },
    },
    {
      endpoint: 'items-read',
      params: { board_id: '1234567890', limit: 25 },
      status: 200,
      response: {
        data: {
          boards: [
            {
              items_page: {
                cursor: 'MSw5NzI4MTA1LGlfSTRnUzZ2cVFuX0xxTVdOWnk3Rzks',
                items: [{ id: '1234567890', name: 'new item' }],
              },
            },
          ],
        },
      },
    },
  ],
};
