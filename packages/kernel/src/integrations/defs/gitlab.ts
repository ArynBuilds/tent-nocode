// GitLab issues door: read a project's issues in, create an issue out; pinned to gitlab.com.
import type { IntegrationDefInput as IntegrationDef } from '../catalog.js';

export const gitlab: IntegrationDef = {
  name: 'gitlab',
  version: 1,
  displayName: 'GitLab',
  blurb: 'Read and create issues in your GitLab projects from your app.',
  category: 'project-management',
  surfaces: 'both',
  scope: 'builder',
  hosts: ['https://gitlab.com'],
  auth: {
    // Token rides the PRIVATE-TOKEN request header.
    kind: 'header',
    header: 'PRIVATE-TOKEN',
    secretName: 'GITLAB_TOKEN',
    tokenHelp:
      'Create a personal access token with the api scope in GitLab under your avatar > Edit profile > Access > Personal access tokens, and paste it as-is.',
  },
  endpoints: [
    {
      id: 'read-issues',
      displayName: 'Read project issues',
      method: 'GET',
      path: '/api/v4/projects/{project_id}/issues',
      class: 'read',
      params: {
        project_id: {
          type: 'string',
          required: true,
          help: 'The numeric project ID, or the full path like my-group/my-project.',
        },
        state: {
          type: 'string',
          choices: ['opened', 'closed', 'all'],
          help: 'Which issues to read; unset reads all.',
        },
        labels: { type: 'string', help: 'Comma-separated label names to filter by.' },
        per_page: { type: 'number', help: 'How many issues per page, up to 100.' },
        page: { type: 'number', help: 'Which page of results to read.' },
      },
      // Picks project the first returned issue; the full list rides the raw response.
      picks: [
        { field: 'iid', from: '0.iid' },
        { field: 'id', from: '0.id' },
        { field: 'title', from: '0.title' },
        { field: 'state', from: '0.state' },
        { field: 'author', from: '0.author.username' },
        { field: 'web_url', from: '0.web_url' },
        { field: 'created_at', from: '0.created_at' },
      ],
    },
    {
      id: 'create-issue',
      displayName: 'Create an issue',
      method: 'POST',
      path: '/api/v4/projects/{project_id}/issues',
      class: 'write',
      params: {
        project_id: {
          type: 'string',
          required: true,
          help: 'The project the issue lands in - numeric ID or full path.',
        },
        title: { type: 'string', required: true, help: 'The one-line title of the issue.' },
        description: { type: 'string', help: 'The issue details, markdown welcome.' },
        labels: { type: 'string', help: 'Comma-separated label names to put on the issue.' },
        confidential: { type: 'boolean', help: 'Hide the issue from users without project access.' },
        issue_type: {
          type: 'string',
          choices: ['issue', 'incident', 'test_case', 'task'],
          help: 'What kind of issue this is; unset means a plain issue.',
        },
      },
      body: 'json',
      picks: [
        { field: 'iid', from: 'iid' },
        { field: 'id', from: 'id' },
        { field: 'title', from: 'title' },
        { field: 'state', from: 'state' },
        { field: 'author', from: 'author.username' },
        { field: 'web_url', from: 'web_url' },
        { field: 'created_at', from: 'created_at' },
      ],
    },
  ],
  inside: {
    // Every read or created issue lands one row; columns fill by name from params and picks.
    tables: [
      {
        name: 'issues',
        displayName: 'Issues',
        rowSchema: {
          'iid': 'number',
          'id': 'number',
          'title': 'string',
          'state': 'string',
          'author': 'string',
          'labels': 'string',
          'web-url': 'string',
          'created-at': 'string',
          'project-id': 'string',
        },
        grain: 'app',
      },
    ],
    watchers: [],
  },
  settings: [
    {
      id: 'default_project_id',
      label: 'Project',
      kind: 'text',
      help: 'The project issues read from and land in when the call names none - numeric ID or full path.',
    },
    {
      id: 'title',
      label: 'Issue title',
      kind: 'template',
      help: 'The issue title with field slots, or bind an input on screen.',
    },
    {
      id: 'default_description',
      label: 'Issue details',
      kind: 'template',
      help: 'The issue description with field slots, markdown welcome.',
    },
  ],
  // Webhook triggers; every body names its event at object_kind.
  triggers: [
    { kind: 'webhook', id: 'issue-changed', displayName: 'Issue opened or changed', eventPath: 'object_kind', events: ['issue'] },
    { kind: 'webhook', id: 'comment-posted', displayName: 'Comment posted', eventPath: 'object_kind', events: ['note'] },
    { kind: 'webhook', id: 'merge-request-changed', displayName: 'Merge request opened or changed', eventPath: 'object_kind', events: ['merge_request'] },
    { kind: 'webhook', id: 'code-pushed', displayName: 'Code pushed', eventPath: 'object_kind', events: ['push'] },
    { kind: 'webhook', id: 'pipeline-status-changed', displayName: 'Pipeline status changed', eventPath: 'object_kind', events: ['pipeline'] },
    { kind: 'webhook', id: 'release-published', displayName: 'Release created or updated', eventPath: 'object_kind', events: ['release'] },
  ],
  fixtures: [
    {
      endpoint: 'read-issues',
      params: { project_id: '4', per_page: 20 },
      status: 200,
      response: [
        {
          project_id: 4,
          id: 41,
          iid: 1,
          title: 'Ut commodi ullam eos dolores perferendis nihil sunt.',
          description: 'Omnis vero earum sunt corporis dolor et placeat.',
          state: 'closed',
          labels: ['foo', 'bar'],
          author: {
            name: 'Administrator',
            username: 'root',
            id: 1,
            state: 'active',
            avatar_url: null,
            web_url: 'https://gitlab.example.com/root',
          },
          created_at: '2016-01-04T15:31:46.176Z',
          web_url: 'http://gitlab.example.com/my-group/my-project/issues/1',
          issue_type: 'issue',
        },
      ],
    },
    {
      endpoint: 'create-issue',
      params: {
        project_id: '4',
        title: 'Ut commodi ullam eos dolores perferendis nihil sunt.',
        description: 'Omnis vero earum sunt corporis dolor et placeat.',
        labels: 'foo,bar',
      },
      status: 201,
      response: {
        project_id: 4,
        id: 41,
        iid: 1,
        title: 'Ut commodi ullam eos dolores perferendis nihil sunt.',
        description: 'Omnis vero earum sunt corporis dolor et placeat.',
        state: 'opened',
        labels: ['foo', 'bar'],
        author: {
          name: 'Administrator',
          username: 'root',
          id: 1,
          state: 'active',
          avatar_url: null,
          web_url: 'https://gitlab.example.com/root',
        },
        created_at: '2016-01-04T15:31:46.176Z',
        web_url: 'http://gitlab.example.com/my-group/my-project/issues/1',
        issue_type: 'issue',
      },
    },
  ],
};
