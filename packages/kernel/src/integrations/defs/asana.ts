// Asana: create a task, read a task back, one mirrored tasks table; the nested data{} envelope rides at-paths.
import type { IntegrationDefInput as IntegrationDef } from '../catalog.js';

export const asana: IntegrationDef = {
  name: 'asana',
  version: 1,
  displayName: 'Asana',
  blurb: 'Create tasks in your Asana projects and read them back into your app.',
  category: 'project-management',
  surfaces: 'both',
  scope: 'builder',
  hosts: ['https://app.asana.com'],
  auth: {
    kind: 'bearer',
    secretName: 'ASANA_ACCESS_TOKEN',
    tokenHelp: 'Create a personal access token in the Asana developer console at app.asana.com/0/my-apps.',
  },
  endpoints: [
    {
      id: 'create-task',
      displayName: 'Create a task',
      method: 'POST',
      path: '/api/1.0/tasks',
      class: 'write',
      params: {
        name: { type: 'string', required: true, at: 'data.name', help: 'The task title.' },
        notes: { type: 'string', at: 'data.notes', help: 'The task description, plain text.' },
        project: { type: 'string', at: 'data.projects.0', help: 'The Asana project gid the task lands in.' },
        workspace: { type: 'string', at: 'data.workspace', help: 'The Asana workspace gid; needed when no project is given.' },
        assignee: { type: 'string', at: 'data.assignee', help: 'Who it is for: a user gid, an email, or me.' },
        due_on: { type: 'string', at: 'data.due_on', help: 'Due date, like 2026-09-15.' },
      },
      body: 'json',
      picks: [
        { field: 'gid', from: 'data.gid' },
        { field: 'name', from: 'data.name' },
        { field: 'completed', from: 'data.completed' },
        { field: 'permalink_url', from: 'data.permalink_url' },
      ],
    },
    {
      id: 'get-task',
      displayName: 'Look up a task',
      method: 'GET',
      path: '/api/1.0/tasks/{task_gid}',
      class: 'read',
      params: {
        task_gid: { type: 'string', required: true, help: 'The task gid, the number in the task link.' },
      },
      picks: [
        { field: 'gid', from: 'data.gid' },
        { field: 'name', from: 'data.name' },
        { field: 'notes', from: 'data.notes' },
        { field: 'completed', from: 'data.completed' },
        { field: 'due_on', from: 'data.due_on' },
        { field: 'permalink_url', from: 'data.permalink_url' },
      ],
    },
  ],
  inside: {
    // Every created or read task lands one row here; kebab columns match their snake twins.
    tables: [
      {
        name: 'tasks',
        displayName: 'Tasks',
        rowSchema: {
          gid: 'string',
          name: 'string',
          notes: 'string',
          completed: 'boolean',
          'due-on': 'string',
          'permalink-url': 'string',
        },
        grain: 'app',
      },
    ],
    watchers: [],
  },
  settings: [
    { id: 'default_project', label: 'Project', kind: 'text', help: 'The Asana project gid new tasks land in when the call names none.' },
    { id: 'default_workspace', label: 'Workspace', kind: 'text', help: 'The Asana workspace gid used when no project is set.' },
    { id: 'default_notes', label: 'Task details', kind: 'template', help: 'The task description with field slots, or bind an input on screen.' },
  ],
  fixtures: [
    {
      endpoint: 'create-task',
      params: {
        name: 'Buy catnip',
        notes: 'Mittens really likes the stuff from Humboldt.',
        project: '12345',
        workspace: '12345',
        due_on: '2019-09-15',
      },
      status: 201,
      response: {
        data: {
          gid: '12345',
          resource_type: 'task',
          name: 'Buy catnip',
          notes: 'Mittens really likes the stuff from Humboldt.',
          completed: false,
          due_on: '2019-09-15',
          workspace: { gid: '12345', resource_type: 'workspace', name: 'My Company Workspace' },
          permalink_url: 'https://app.asana.com/1/12345/task/123456789',
        },
      },
    },
    {
      endpoint: 'get-task',
      params: { task_gid: '12345' },
      status: 200,
      response: {
        data: {
          gid: '12345',
          resource_type: 'task',
          name: 'Buy catnip',
          notes: 'Mittens really likes the stuff from Humboldt.',
          completed: false,
          due_on: '2019-09-15',
          permalink_url: 'https://app.asana.com/1/12345/task/123456789',
        },
      },
    },
  ],
};
