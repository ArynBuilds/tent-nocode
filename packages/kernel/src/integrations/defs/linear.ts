// Linear issue create/read over GraphQL; queries in bodyConstants, params in variables; API key in Authorization header.
import type { IntegrationDefInput as IntegrationDef } from '../catalog.js';

export const linear: IntegrationDef = {
  name: 'linear',
  version: 1,
  displayName: 'Linear',
  blurb: 'Create issues in your Linear workspace and read them back into your app.',
  category: 'project-management',
  surfaces: 'both',
  scope: 'builder',
  hosts: ['https://api.linear.app'],
  auth: {
    kind: 'header',
    header: 'Authorization',
    secretName: 'LINEAR_API_KEY',
    tokenHelp: 'Create a personal API key in Linear under Settings > Security & access > Personal API keys; paste the key as-is.',
  },
  endpoints: [
    {
      id: 'create-issue',
      displayName: 'Create an issue',
      method: 'POST',
      path: '/graphql',
      class: 'write',
      bodyConstants: {
        query:
          'mutation IssueCreate($title: String!, $teamId: String!, $description: String) { issueCreate(input: { title: $title, teamId: $teamId, description: $description }) { success issue { id identifier title url } } }',
      },
      params: {
        title: { type: 'string', required: true, at: 'variables.title', help: 'The issue title.' },
        team_id: { type: 'string', required: true, at: 'variables.teamId', help: 'The Linear team id the issue lands in.' },
        description: { type: 'string', at: 'variables.description', help: 'The issue details, markdown welcome.' },
      },
      body: 'json',
      picks: [
        { field: 'success', from: 'data.issueCreate.success' },
        { field: 'id', from: 'data.issueCreate.issue.id' },
        { field: 'identifier', from: 'data.issueCreate.issue.identifier' },
        { field: 'title', from: 'data.issueCreate.issue.title' },
        { field: 'url', from: 'data.issueCreate.issue.url' },
      ],
    },
    {
      id: 'read-issues',
      displayName: 'Read your issues',
      method: 'POST',
      path: '/graphql',
      class: 'read',
      bodyConstants: {
        query:
          'query TeamIssues($teamId: String!, $first: Int) { team(id: $teamId) { issues(first: $first) { nodes { id identifier title url } } } }',
      },
      params: {
        team_id: { type: 'string', required: true, at: 'variables.teamId', help: 'The Linear team id to read issues from.' },
        first: { type: 'number', at: 'variables.first', help: 'How many issues to read, up to 50.' },
      },
      body: 'json',
      picks: [
        { field: 'id', from: 'data.team.issues.nodes.0.id' },
        { field: 'identifier', from: 'data.team.issues.nodes.0.identifier' },
        { field: 'title', from: 'data.team.issues.nodes.0.title' },
        { field: 'url', from: 'data.team.issues.nodes.0.url' },
      ],
    },
  ],
  inside: {
    tables: [
      {
        name: 'issues',
        displayName: 'Issues',
        rowSchema: {
          id: 'string',
          identifier: 'string',
          title: 'string',
          description: 'string',
          url: 'string',
          'team-id': 'string',
        },
        grain: 'app',
      },
    ],
    watchers: [],
  },
  settings: [
    { id: 'default_team_id', label: 'Team', kind: 'text', help: 'The Linear team id new issues land in when the call names none.' },
    { id: 'default_description', label: 'Issue details', kind: 'template', help: 'The issue description with field slots, or bind an input on screen.' },
  ],
  triggers: [
    { kind: 'webhook', id: 'issue-changed', displayName: 'Issue added or changed', eventPath: 'type', events: ['Issue'] },
    { kind: 'webhook', id: 'comment-changed', displayName: 'Comment added or changed', eventPath: 'type', events: ['Comment'] },
    { kind: 'webhook', id: 'project-changed', displayName: 'Project added or changed', eventPath: 'type', events: ['Project'] },
  ],
  fixtures: [
    {
      endpoint: 'create-issue',
      params: {
        title: 'New exception',
        team_id: '9cfb482a-81e3-4154-b5b9-2c805e70a02d',
        description: 'More detailed error report in markdown',
      },
      status: 200,
      response: {
        data: {
          issueCreate: {
            success: true,
            issue: {
              id: 'a58d20bc-e33d-42ee-9b95-e10d3b3ce82a',
              identifier: 'ENG-123',
              title: 'New exception',
              url: 'https://linear.app/my-company/issue/ENG-123/new-exception',
            },
          },
        },
      },
    },
    {
      endpoint: 'read-issues',
      params: { team_id: '9cfb482a-81e3-4154-b5b9-2c805e70a02d', first: 10 },
      status: 200,
      response: {
        data: {
          team: {
            issues: {
              nodes: [
                {
                  id: 'a58d20bc-e33d-42ee-9b95-e10d3b3ce82a',
                  identifier: 'ENG-123',
                  title: 'New exception',
                  url: 'https://linear.app/my-company/issue/ENG-123/new-exception',
                },
              ],
            },
          },
        },
      },
    },
  ],
};
