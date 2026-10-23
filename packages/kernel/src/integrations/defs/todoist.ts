import type { IntegrationDefInput as IntegrationDef } from '../catalog.js';

// Todoist integration: add and list tasks over the unified /api/v1 paths.
export const todoist: IntegrationDef = {
  name: 'todoist',
  version: 1,
  displayName: 'Todoist',
  blurb: 'Add tasks to your own Todoist and read your task list from your app.',
  category: 'project-management',
  surfaces: 'both',
  scope: 'builder',
  hosts: ['https://api.todoist.com'],
  auth: {
    kind: 'bearer',
    secretName: 'TODOIST_API_TOKEN',
    tokenHelp: 'Copy your API token from Todoist Settings, under Integrations, on the Developer tab.',
  },
  endpoints: [
    {
      id: 'create-task',
      displayName: 'Add a task',
      method: 'POST',
      path: '/api/v1/tasks',
      class: 'write',
      body: 'json',
      params: {
        content: { type: 'string', required: true, help: 'The task text, like Buy milk.' },
        description: { type: 'string', help: 'Extra notes shown under the task.' },
        project_id: { type: 'string', help: 'The project the task lands in; leave unset for your Inbox.' },
        due_string: { type: 'string', help: 'A natural due date, like tomorrow at 12:00.' },
        priority: { type: 'number', help: 'From 1 (normal) to 4 (urgent).' },
      },
      picks: [
        { field: 'id', from: 'id' },
        { field: 'project_id', from: 'project_id' },
        { field: 'due_date', from: 'due.date' },
      ],
    },
    {
      id: 'list-tasks',
      displayName: 'List your tasks',
      method: 'GET',
      path: '/api/v1/tasks',
      class: 'read',
      params: {
        project_id: { type: 'string', help: 'Only tasks from this project; leave unset for all your tasks.' },
        label: { type: 'string', help: 'Only tasks carrying this label name.' },
        limit: { type: 'number', help: 'How many tasks to return, up to 200.' },
      },
      // List responses are paginated; picks land the first task per call.
      picks: [
        { field: 'id', from: 'results.0.id' },
        { field: 'content', from: 'results.0.content' },
        { field: 'project_id', from: 'results.0.project_id' },
        { field: 'priority', from: 'results.0.priority' },
        { field: 'due_date', from: 'results.0.due.date' },
      ],
    },
  ],
  inside: {
    // Task feed pulls once per app; columns fill by name from params first, then picks.
    tables: [
      {
        name: 'tasks',
        displayName: 'Tasks',
        rowSchema: {
          id: 'string',
          content: 'string',
          'project-id': 'string',
          'due-string': 'string',
          'due-date': 'string',
          priority: 'number',
        },
        grain: 'app',
      },
    ],
    watchers: [],
  },
  settings: [
    // Setting names match the params they fill.
    { id: 'content', label: 'Task text', kind: 'template', help: 'The task text with field slots, or bind an input on screen.' },
    { id: 'default_project_id', label: 'Project', kind: 'text', help: 'The Todoist project new tasks land in; leave unset for your Inbox.' },
    { id: 'default_due_string', label: 'Due', kind: 'text', help: 'A natural due date for new tasks, like tomorrow.' },
  ],
  fixtures: [
    {
      endpoint: 'create-task',
      params: { content: 'Buy milk', due_string: 'tomorrow at 12:00', priority: 2 },
      status: 200,
      response: {
        id: '6XGgmFVcrG5RRjVr',
        user_id: '1234567',
        project_id: '6XGgm6PHrGgMpCFX',
        section_id: null,
        parent_id: null,
        content: 'Buy milk',
        description: '',
        priority: 2,
        labels: [],
        checked: false,
        is_deleted: false,
        added_at: '2025-01-15T10:30:00Z',
        due: { date: '2025-02-12', is_recurring: false, lang: 'en', string: 'tomorrow at 12:00' },
        child_order: 1,
        day_order: 1,
      },
    },
    {
      endpoint: 'list-tasks',
      params: { project_id: '6XGgm6PHrGgMpCFX', limit: 50 },
      status: 200,
      response: {
        results: [
          {
            id: '6XGgmFVcrG5RRjVr',
            user_id: '1234567',
            project_id: '6XGgm6PHrGgMpCFX',
            section_id: null,
            parent_id: null,
            content: 'Buy milk',
            description: 'Pick up two liters of whole milk.',
            priority: 1,
            labels: ['priority'],
            checked: false,
            is_deleted: false,
            added_at: '2025-01-15T10:30:00Z',
            due: { date: '2025-02-12', is_recurring: false, lang: 'en', string: 'tomorrow' },
            child_order: 1,
            day_order: 1,
          },
        ],
        next_cursor: null,
      },
    },
  ],
};
