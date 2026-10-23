// ClickUp connector: create a task out, read one back in.
import type { IntegrationDefInput as IntegrationDef } from '../catalog.js';

export const clickup: IntegrationDef = {
  name: 'clickup',
  version: 1,
  displayName: 'ClickUp',
  blurb: 'Create tasks in your own ClickUp workspace from your app and read them back in.',
  category: 'project-management',
  surfaces: 'both',
  scope: 'builder',
  hosts: ['https://api.clickup.com'],
  auth: {
    // ClickUp wants the raw token in Authorization, no Bearer scheme.
    kind: 'header',
    header: 'Authorization',
    secretName: 'CLICKUP_API_TOKEN',
    tokenHelp:
      'In ClickUp open your avatar menu, then Settings, then Apps, and copy your personal API Token.',
  },
  endpoints: [
    {
      id: 'create-task',
      displayName: 'Create a task',
      method: 'POST',
      path: '/api/v2/list/{list_id}/task',
      class: 'write',
      params: {
        list_id: {
          type: 'string',
          required: true,
          help: 'The ClickUp list the task lands in - the number in the list URL.',
        },
        name: {
          type: 'string',
          required: true,
          help: 'The task title.',
        },
        description: {
          type: 'string',
          help: 'The task details, plain text.',
        },
        status: {
          type: 'string',
          help: 'A status name from that list, like "to do". Left unset, the list default applies.',
        },
        priority: {
          type: 'number',
          help: '1 urgent, 2 high, 3 normal, 4 low.',
        },
        due_date: {
          type: 'number',
          help: 'The due moment as a millisecond timestamp.',
        },
      },
      body: 'json',
      picks: [
        { field: 'id', from: 'id' },
        { field: 'url', from: 'url' },
        { field: 'status', from: 'status.status' },
      ],
    },
    {
      id: 'get-task',
      displayName: 'Look up a task',
      method: 'GET',
      path: '/api/v2/task/{task_id}',
      class: 'read',
      params: {
        task_id: {
          type: 'string',
          required: true,
          help: 'The task id, from the task URL or a created task.',
        },
      },
      picks: [
        { field: 'id', from: 'id' },
        { field: 'name', from: 'name' },
        { field: 'status', from: 'status.status' },
        { field: 'url', from: 'url' },
        { field: 'date_created', from: 'date_created' },
      ],
    },
  ],
  inside: {
    // Tasks touched through the wire land here; columns fill by name from params then picks.
    tables: [
      {
        name: 'tasks',
        displayName: 'Tasks',
        rowSchema: {
          id: 'string',
          name: 'string',
          status: 'string',
          url: 'string',
          'list-id': 'string',
          'date-created': 'string',
        },
        grain: 'app',
      },
    ],
    watchers: [
      { id: 'task-created', displayName: 'When a task is created', event: 'taskCreated' },
      { id: 'task-updated', displayName: 'When a task changes', event: 'taskUpdated' },
    ],
  },
  settings: [
    {
      id: 'default_list_id',
      label: 'List',
      kind: 'text',
      help: 'The ClickUp list new tasks land in by default - the number in the list URL.',
    },
    {
      id: 'default_name',
      label: 'Task name',
      kind: 'template',
      help: 'The task title with field slots, or bind an input on screen.',
    },
    {
      id: 'default_description',
      label: 'Task details',
      kind: 'template',
      help: 'The task details with field slots, or bind an input on screen.',
    },
  ],
  // Webhook triggers; the delivered body names the event at top-level 'event'.
  triggers: [
    { kind: 'webhook', id: 'task-created', displayName: 'Task created', eventPath: 'event', events: ['taskCreated'] },
    { kind: 'webhook', id: 'task-changed', displayName: 'Task changed', eventPath: 'event', events: ['taskUpdated'] },
    { kind: 'webhook', id: 'task-status-changed', displayName: 'Task status changed', eventPath: 'event', events: ['taskStatusUpdated'] },
    { kind: 'webhook', id: 'comment-posted', displayName: 'Comment posted on a task', eventPath: 'event', events: ['taskCommentPosted'] },
  ],
  fixtures: [
    {
      endpoint: 'create-task',
      params: { list_id: '123', name: 'New Task Name', description: 'New Task Description' },
      status: 200,
      response: {
        id: '9hz',
        name: 'New Task Name',
        description: 'New Task Description',
        status: { status: 'to do', color: '#d3d3d3', type: 'open', orderindex: 0 },
        url: 'https://app.clickup.com/t/9hz',
        list: { id: '123', name: 'List' },
      },
    },
    {
      endpoint: 'get-task',
      params: { task_id: '9hz' },
      status: 200,
      response: {
        id: '9hz',
        name: 'New Task Name',
        status: { status: 'in progress', color: '#d3d3d3', type: 'custom', orderindex: 1 },
        date_created: '1567780450202',
        date_updated: '1567780450202',
        url: 'https://app.clickup.com/t/9hz',
      },
    },
  ],
};
