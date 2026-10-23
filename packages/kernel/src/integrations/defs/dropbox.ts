import type { IntegrationDefInput as IntegrationDef } from '../catalog.js';

// Dropbox folder mirror + folder create; every data endpoint is an RPC POST with a json body, and the root folder path is the empty string.
export const dropbox: IntegrationDef = {
  name: 'dropbox',
  version: 1,
  displayName: 'Dropbox',
  blurb: 'Mirror a Dropbox folder into a Table and create folders in your Dropbox from your app.',
  category: 'storage',
  availability: 'upcoming',
  surfaces: 'both',
  scope: 'both',
  hosts: ['https://api.dropboxapi.com'],
  auth: {
    kind: 'oauth',
    authUrl: 'https://www.dropbox.com/oauth2/authorize',
    tokenUrl: 'https://api.dropboxapi.com/oauth2/token',
    scopes: ['files.metadata.read', 'files.content.write'],
    clientEnv: 'DROPBOX',
    tokenHelp:
      'Click Sign in to Dropbox and allow file access - there is no key to copy.',
  },
  endpoints: [
    {
      id: 'list-folder',
      displayName: 'Read a folder',
      method: 'POST',
      path: '/2/files/list_folder',
      class: 'read',
      body: 'json',
      params: {
        path: {
          type: 'string',
          required: true,
          help: 'The folder to read, like /invoices - leave it empty for the whole Dropbox root.',
        },
        recursive: {
          type: 'boolean',
          help: 'Also read everything inside subfolders.',
        },
        limit: {
          type: 'number',
          help: 'How many entries to read per pull, up to 2000.',
        },
      },
      picks: [
        { field: 'cursor', from: 'cursor' },
        { field: 'has_more', from: 'has_more' },
      ],
    },
    {
      id: 'create-folder',
      displayName: 'Add a folder',
      method: 'POST',
      path: '/2/files/create_folder_v2',
      class: 'write',
      body: 'json',
      params: {
        path: {
          type: 'string',
          required: true,
          help: 'Where the new folder lands, like /invoices/2026.',
        },
        autorename: {
          type: 'boolean',
          help: 'If a folder with this name already exists, pick a new name instead of refusing.',
        },
      },
      picks: [
        { field: 'id', from: 'metadata.id' },
        { field: 'name', from: 'metadata.name' },
        { field: 'path_lower', from: 'metadata.path_lower' },
      ],
    },
  ],
  inside: {
    // One row per file or folder; the '.tag' kind cannot land by name.
    tables: [
      {
        name: 'entries',
        displayName: 'Entries',
        rowSchema: {
          name: 'string',
          id: 'string',
          'path-lower': 'string',
        },
        grain: 'app',
        fromArray: 'entries',
      },
    ],
    watchers: [],
  },
  // Folder read fires every 30 minutes; the mirror waits until the path setting is filled.
  sync: { endpoint: 'list-folder', everyMinutes: 30 },
  settings: [
    {
      id: 'path',
      label: 'Folder',
      kind: 'text',
      help: 'The folder this node mirrors and creates in, like /invoices - the mirror waits until this is set.',
    },
  ],
  fixtures: [
    {
      endpoint: 'list-folder',
      params: { path: '/homework/math', limit: 2 },
      status: 200,
      response: {
        entries: [
          {
            '.tag': 'file',
            name: 'Prime_Numbers.txt',
            id: 'id:a4ayc_80_OEAAAAAAAAAXw',
            client_modified: '2015-05-12T15:50:38Z',
            server_modified: '2015-05-12T15:50:38Z',
            rev: 'a1c10ce0dd78',
            size: 7212,
            path_lower: '/homework/math/prime_numbers.txt',
            path_display: '/Homework/math/Prime_Numbers.txt',
            is_downloadable: true,
          },
          {
            '.tag': 'folder',
            name: 'math',
            id: 'id:a4ayc_80_OEAAAAAAAAAXz',
            path_lower: '/homework/math',
            path_display: '/Homework/math',
          },
        ],
        cursor: 'ZtkX9_EHj3x7PMkVuFIhwKYXEpwpLwyxp9vMKomUhll',
        has_more: false,
      },
    },
    {
      endpoint: 'create-folder',
      params: { path: '/Homework/math', autorename: false },
      status: 200,
      response: {
        metadata: {
          id: 'id:a4ayc_80_OEAAAAAAAAAXz',
          name: 'math',
          path_display: '/Homework/math',
          path_lower: '/homework/math',
        },
      },
    },
  ],
};
