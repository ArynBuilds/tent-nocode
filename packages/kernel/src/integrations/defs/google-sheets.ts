import type { IntegrationDefInput as IntegrationDef } from '../catalog.js';

// Google Sheets read and append; values.get returns arrays (no field names), append uses batchUpdate for query param constraint.
export const googleSheets: IntegrationDef = {
  name: 'google-sheets',
  version: 1,
  displayName: 'Google Sheets',
  blurb: 'Read cells from a Google Sheet into your app and add rows to it from a button.',
  category: 'productivity',
  surfaces: 'both',
  scope: 'both',
  availability: 'upcoming',
  hosts: ['https://sheets.googleapis.com'],
  auth: {
    kind: 'oauth',
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    clientEnv: 'GOOGLE',
    tokenHelp: 'Nothing to paste - you sign in with your Google account when you connect.',
  },
  endpoints: [
    {
      id: 'read-values',
      displayName: 'Read cells',
      method: 'GET',
      path: '/v4/spreadsheets/{spreadsheet_id}/values/{range}',
      class: 'read',
      params: {
        spreadsheet_id: {
          type: 'string',
          required: true,
          help: 'The long ID in the sheet link, between /d/ and /edit.',
        },
        range: {
          type: 'string',
          required: true,
          help: 'Which cells to read, like Sheet1!A1:C10 - or a single cell like Sheet1!B2.',
        },
      },
      picks: [{ field: 'value', from: 'values.0.0' }],
    },
    {
      id: 'append-row',
      displayName: 'Add a row',
      method: 'POST',
      path: '/v4/spreadsheets/{spreadsheet_id}:batchUpdate',
      class: 'write',
      body: 'json',
      bodyConstants: {
        'requests.0.appendCells.fields': 'userEnteredValue',
      },
      params: {
        spreadsheet_id: {
          type: 'string',
          required: true,
          help: 'The long ID in the sheet link, between /d/ and /edit.',
        },
        sheet_id: {
          type: 'number',
          required: true,
          at: 'requests.0.appendCells.sheetId',
          help: 'The tab the row lands in - the number after gid= in the tab link. The first tab is 0.',
        },
        value_1: {
          type: 'string',
          required: true,
          at: 'requests.0.appendCells.rows.0.values.0.userEnteredValue.stringValue',
          help: 'The first cell of the new row. Cells write as text.',
        },
        value_2: {
          type: 'string',
          at: 'requests.0.appendCells.rows.0.values.1.userEnteredValue.stringValue',
          help: 'The second cell of the new row.',
        },
        value_3: {
          type: 'string',
          at: 'requests.0.appendCells.rows.0.values.2.userEnteredValue.stringValue',
          help: 'The third cell of the new row.',
        },
        value_4: {
          type: 'string',
          at: 'requests.0.appendCells.rows.0.values.3.userEnteredValue.stringValue',
          help: 'The fourth cell of the new row.',
        },
      },
      picks: [{ field: 'spreadsheet_id', from: 'spreadsheetId' }],
    },
  ],
  inside: {
    tables: [
      {
        name: 'cells',
        displayName: 'Cells',
        rowSchema: {
          range: 'string',
          value: 'string',
        },
        grain: 'app',
      },
    ],
    watchers: [],
  },
  sync: { endpoint: 'read-values', everyMinutes: 30 },
  settings: [
    {
      id: 'spreadsheet_id',
      label: 'Spreadsheet',
      kind: 'text',
      help: 'The long ID in the sheet link, between /d/ and /edit.',
    },
    {
      id: 'range',
      label: 'Cells',
      kind: 'text',
      help: 'Which cells this node reads, like Sheet1!A1:C10 - or one cell like Sheet1!B2.',
    },
    {
      id: 'sheet_id',
      label: 'Tab',
      kind: 'number',
      help: 'The tab new rows land in - the number after gid= in the tab link. The first tab is 0.',
    },
  ],
  triggers: [
    { kind: 'poll', id: 'cell-value-changed', displayName: 'Cell value changed', table: 'cells' },
  ],
  fixtures: [
    {
      endpoint: 'read-values',
      params: {
        spreadsheet_id: '1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms',
        range: 'Sheet1!A1:B2',
      },
      status: 200,
      response: {
        range: 'Sheet1!A1:B2',
        majorDimension: 'ROWS',
        values: [
          ['Item', 'Cost'],
          ['Wheel', '$20.50'],
        ],
      },
    },
    {
      endpoint: 'append-row',
      params: {
        spreadsheet_id: '1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms',
        sheet_id: 0,
        value_1: 'Door',
        value_2: '$15.00',
      },
      status: 200,
      response: {
        spreadsheetId: '1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms',
        replies: [{}],
      },
    },
  ],
};
