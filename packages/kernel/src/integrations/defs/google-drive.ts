import type { IntegrationDefInput as IntegrationDef } from '../catalog.js';

// Google Drive file list mirror, read-only; no upload or mimeType due to binary bodies and camelCase mismatch.
export const googleDrive: IntegrationDef = {
  name: 'google-drive',
  version: 1,
  displayName: 'Google Drive',
  blurb: 'Mirror the files in your Google Drive into a Table your app can read.',
  category: 'storage',
  surfaces: 'both',
  scope: 'both',
  availability: 'upcoming',
  hosts: ['https://www.googleapis.com'],
  auth: {
    kind: 'oauth',
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scopes: ['https://www.googleapis.com/auth/drive.readonly'],
    clientEnv: 'GOOGLE',
    tokenHelp: 'Nothing to paste - you sign in with your Google account when you connect.',
  },
  endpoints: [
    {
      id: 'list-files',
      displayName: 'List your files',
      method: 'GET',
      path: '/drive/v3/files',
      class: 'read',
      params: {
        q: {
          type: 'string',
          help: "A Drive search that narrows the list, like name contains 'report'. Empty lists everything you can see.",
        },
        page_size: {
          type: 'number',
          wire: 'pageSize',
          help: 'How many files to read per pull, up to 1000.',
        },
        page_token: {
          type: 'string',
          wire: 'pageToken',
          help: 'The continuation token from the previous pull, to read the next page.',
        },
      },
      picks: [{ field: 'next_page_token', from: 'nextPageToken' }],
    },
  ],
  inside: {
    tables: [
      {
        name: 'files',
        displayName: 'Files',
        rowSchema: {
          id: 'string',
          name: 'string',
        },
        grain: 'app',
        fromArray: 'files',
      },
    ],
    watchers: [],
  },
  sync: { endpoint: 'list-files', everyMinutes: 30 },
  settings: [
    {
      id: 'q',
      label: 'Filter',
      kind: 'text',
      help: "A Drive search that narrows the mirror, like name contains 'report'. Leave empty to mirror everything you can see.",
    },
  ],
  triggers: [
    { kind: 'poll', id: 'file-changed', displayName: 'File added or changed', table: 'files' },
  ],
  fixtures: [
    {
      endpoint: 'list-files',
      params: { q: "name contains 'report'", page_size: 2 },
      status: 200,
      response: {
        kind: 'drive#fileList',
        incompleteSearch: false,
        nextPageToken: 'V1*3|0|XNzZWdtZW50IjoiMTdIRUFPN0YifQ',
        files: [
          {
            kind: 'drive#file',
            id: '1dP5eB0AVzL9kBmS3g0Zq7cX8yWk4nT2F',
            name: 'Quarterly report',
            mimeType: 'application/vnd.google-apps.document',
          },
          {
            kind: 'drive#file',
            id: '0B7yGh4KpNqRsT2VuY3lXbWQxZkE',
            name: 'report-photo.jpg',
            mimeType: 'image/jpeg',
          },
        ],
      },
    },
  ],
};
