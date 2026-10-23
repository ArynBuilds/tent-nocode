import type { IntegrationDefInput as IntegrationDef } from '../catalog.js';

// Box folder read plus folder create over OAuth; file upload waits on a multipart body lane, so upload.box.com stays undeclared.
export const box: IntegrationDef = {
  name: 'box',
  version: 1,
  displayName: 'Box',
  blurb: 'Mirror a Box folder into a Table and create folders in your Box from your app.',
  category: 'storage',
  availability: 'upcoming',
  surfaces: 'both',
  scope: 'both',
  hosts: ['https://api.box.com'],
  auth: {
    kind: 'oauth',
    authUrl: 'https://account.box.com/api/oauth2/authorize',
    tokenUrl: 'https://api.box.com/oauth2/token',
    // root_readwrite covers both the folder read and the folder create.
    scopes: ['root_readwrite'],
    clientEnv: 'BOX',
    tokenHelp:
      'Click Sign in to Box and allow file access - there is no key to copy.',
  },
  endpoints: [
    {
      id: 'list-items',
      displayName: 'Read a folder',
      method: 'GET',
      path: '/2.0/folders/{folder_id}/items',
      class: 'read',
      params: {
        folder_id: {
          type: 'string',
          required: true,
          help: 'The folder to read - 0 is the root folder.',
        },
        limit: {
          type: 'number',
          help: 'How many entries to read per pull, up to 1000.',
        },
        offset: {
          type: 'number',
          help: 'How many entries to skip before reading.',
        },
      },
      picks: [{ field: 'total_count', from: 'total_count' }],
    },
    {
      id: 'create-folder',
      displayName: 'Add a folder',
      method: 'POST',
      path: '/2.0/folders',
      class: 'write',
      body: 'json',
      params: {
        name: {
          type: 'string',
          required: true,
          help: 'The name of the new folder.',
        },
        parent_id: {
          type: 'string',
          required: true,
          at: 'parent.id',
          help: 'The folder to create inside - 0 is the root folder.',
        },
      },
      picks: [
        { field: 'id', from: 'id' },
        { field: 'name', from: 'name' },
        { field: 'type', from: 'type' },
      ],
    },
  ],
  inside: {
    // One row per file, folder, or web link; id, name, type land by element field name.
    tables: [
      {
        name: 'entries',
        displayName: 'Entries',
        rowSchema: {
          id: 'string',
          name: 'string',
          type: 'string',
        },
        grain: 'app',
        fromArray: 'entries',
      },
    ],
    watchers: [],
  },
  // Mirror sync: the folder_id setting fills the required param.
  sync: { endpoint: 'list-items', everyMinutes: 30 },
  settings: [
    {
      id: 'folder_id',
      label: 'Folder',
      kind: 'text',
      help: 'The folder this node mirrors and creates in - 0 is the root folder.',
    },
  ],
  // The notification body's top-level 'trigger' carries the event name; firing waits on the box signature dialect.
  triggers: [
    { kind: 'webhook', id: 'file-uploaded', displayName: 'File uploaded', eventPath: 'trigger', events: ['FILE.UPLOADED'] },
    { kind: 'webhook', id: 'file-removed', displayName: 'File removed', eventPath: 'trigger', events: ['FILE.TRASHED', 'FILE.DELETED'] },
    { kind: 'webhook', id: 'folder-created', displayName: 'Folder created', eventPath: 'trigger', events: ['FOLDER.CREATED'] },
    { kind: 'webhook', id: 'folder-removed', displayName: 'Folder removed', eventPath: 'trigger', events: ['FOLDER.TRASHED', 'FOLDER.DELETED'] },
  ],
  fixtures: [
    {
      endpoint: 'list-items',
      params: { folder_id: '0', limit: 100 },
      status: 200,
      response: {
        total_count: 2,
        entries: [
          {
            id: '12345',
            etag: '1',
            type: 'file',
            sequence_id: '3',
            name: 'Contract.pdf',
          },
          {
            id: '12346',
            etag: '1',
            type: 'folder',
            sequence_id: '3',
            name: 'Pictures',
          },
        ],
        offset: 0,
        limit: 100,
      },
    },
    {
      endpoint: 'create-folder',
      params: { name: 'Pictures', parent_id: '0' },
      status: 201,
      response: {
        id: '12345',
        etag: '1',
        type: 'folder',
        sequence_id: '3',
        name: 'Pictures',
      },
    },
  ],
};
