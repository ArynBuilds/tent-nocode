import type { IntegrationDefInput as IntegrationDef } from '../catalog.js';

// Basecamp to-dos over launchpad OAuth; account_id rides every path and fills from a setting; the list response is a bare array so no fan-out mirror.
export const basecamp: IntegrationDef = {
  name: 'basecamp',
  version: 1,
  displayName: 'Basecamp',
  blurb: 'Bring the to-dos from your Basecamp project into your app and add new ones from it.',
  category: 'productivity',
  availability: 'upcoming',
  surfaces: 'both',
  scope: 'builder',
  hosts: ['https://3.basecampapi.com'],
  auth: {
    kind: 'oauth',
    // type=web_server is required on both URLs and survives the URL builder untouched.
    authUrl: 'https://launchpad.37signals.com/authorization/new?type=web_server',
    tokenUrl: 'https://launchpad.37signals.com/authorization/token?type=web_server',
    // Basecamp has no scopes; the empty array is honest.
    scopes: [],
    clientEnv: 'BASECAMP',
    tokenHelp: 'Click Sign in to Basecamp and approve access to your account - there is no key to paste.',
  },
  // Basecamp refuses requests without an app-identifying User-Agent (400).
  headers: { 'user-agent': 'Nodeloom (https://github.com/ArynBuilds/tentis)' },
  endpoints: [
    {
      id: 'list-todos',
      displayName: 'Read your to-dos',
      method: 'GET',
      path: '/{account_id}/todolists/{todolist_id}/todos.json',
      class: 'read',
      params: {
        account_id: {
          type: 'string',
          required: true,
          help: 'Your Basecamp account ID - the number in your Basecamp URL right after basecamp.com, like 195539477.',
        },
        todolist_id: {
          type: 'string',
          required: true,
          help: 'The to-do list to read - open it in Basecamp and take the number at the end of its URL.',
        },
        status: {
          type: 'string',
          choices: ['archived', 'trashed'],
          help: 'Leave unset for active to-dos, or read the archived or trashed ones.',
        },
        completed: {
          type: 'boolean',
          help: 'Set to true to read only completed to-dos.',
        },
      },
      // The response is a bare array; leading-numeric picks reach the first element, the total rides a header.
      picks: [
        { field: 'id', from: '0.id' },
        { field: 'title', from: '0.title' },
        { field: 'status', from: '0.status' },
        { field: 'completed', from: '0.completed' },
        { field: 'due_on', from: '0.due_on' },
        { field: 'count', fromHeader: 'X-Total-Count' },
      ],
    },
    {
      id: 'create-todo',
      displayName: 'Add a to-do',
      method: 'POST',
      path: '/{account_id}/todolists/{todolist_id}/todos.json',
      class: 'write',
      body: 'json',
      params: {
        account_id: {
          type: 'string',
          required: true,
          help: 'Your Basecamp account ID - the Connect settings fill this once for every call.',
        },
        todolist_id: {
          type: 'string',
          required: true,
          help: 'The to-do list the new to-do lands in.',
        },
        content: {
          type: 'string',
          required: true,
          help: 'What the to-do says, like: Call the printer about the brochure.',
        },
        description: {
          type: 'string',
          help: 'A longer note under the to-do. Basecamp renders it as rich text.',
        },
        due_on: {
          type: 'string',
          help: 'When it is due, as a date like 2027-05-01.',
        },
      },
      picks: [
        { field: 'id', from: 'id' },
        { field: 'title', from: 'title' },
        { field: 'status', from: 'status' },
        { field: 'completed', from: 'completed' },
        { field: 'due_on', from: 'due_on' },
      ],
    },
  ],
  inside: {
    // No fromArray: one row lands per pull from the picks; a created to-do lands its own row.
    tables: [
      {
        name: 'todos',
        displayName: 'To-dos',
        rowSchema: {
          id: 'number',
          title: 'string',
          status: 'string',
          completed: 'boolean',
          'due-on': 'string',
        },
        grain: 'app',
      },
    ],
    watchers: [],
  },
  // Mirror sync: both required params fill from the settings below.
  sync: { endpoint: 'list-todos', everyMinutes: 60 },
  settings: [
    {
      id: 'account_id',
      label: 'Account ID',
      kind: 'text',
      help: 'The number in your Basecamp URL right after basecamp.com, like 195539477.',
    },
    {
      id: 'todolist_id',
      label: 'To-do list ID',
      kind: 'text',
      help: 'Open the to-do list in Basecamp - the number at the end of its URL.',
    },
  ],
  fixtures: [
    {
      endpoint: 'list-todos',
      params: { account_id: '195539477', todolist_id: '1069480012' },
      status: 200,
      response: [
        {
          id: 1069480013,
          status: 'active',
          visible_to_clients: false,
          created_at: '2026-05-12T04:29:00.000Z',
          updated_at: '2026-05-12T04:29:00.000Z',
          title: 'Go cutting edge: iOS8 and Android 4.5 only',
          inherits_status: true,
          type: 'Todo',
          url: 'https://3.basecampapi.com/195539477/buckets/2085958505/todos/1069480013.json',
          app_url: 'https://3.basecamp.com/195539477/buckets/2085958505/todos/1069480013',
          comments_count: 0,
          position: 1,
          parent: {
            id: 1069480012,
            title: 'Version 2 punch list',
            type: 'Todolist',
          },
          description: '',
          completed: false,
          content: 'Go cutting edge: iOS8 and Android 4.5 only',
          starts_on: null,
          due_on: null,
          assignees: [],
          completion_subscribers: [],
        },
      ],
    },
    {
      endpoint: 'create-todo',
      params: {
        account_id: '195539477',
        todolist_id: '1069480012',
        content: 'Program it',
        description: '<div><em>Try that new language!</em></div>',
        due_on: '2027-05-01',
      },
      status: 201,
      response: {
        id: 1069480015,
        status: 'active',
        visible_to_clients: false,
        created_at: '2026-05-12T04:31:00.000Z',
        updated_at: '2026-05-12T04:31:00.000Z',
        title: 'Program it',
        inherits_status: true,
        type: 'Todo',
        url: 'https://3.basecampapi.com/195539477/buckets/2085958505/todos/1069480015.json',
        app_url: 'https://3.basecamp.com/195539477/buckets/2085958505/todos/1069480015',
        comments_count: 0,
        position: 3,
        parent: {
          id: 1069480012,
          title: 'Version 2 punch list',
          type: 'Todolist',
        },
        description: '<div><em>Try that new language!</em></div>',
        completed: false,
        content: 'Program it',
        starts_on: null,
        due_on: '2027-05-01',
        assignees: [],
        completion_subscribers: [],
      },
    },
  ],
};
