import type { IntegrationDefInput as IntegrationDef } from '../catalog.js';

// PostHog query-API def; capture is excluded because it needs the api_key in the json body.
export const posthog: IntegrationDef = {
  name: 'posthog',
  version: 1,
  displayName: 'PostHog',
  blurb: 'Bring your PostHog analytics numbers into your app on your own key.',
  category: 'data',
  surfaces: 'both',
  scope: 'builder',
  // The private API is regional; the owner picks us or eu at Connect.
  hosts: { template: 'https://{dc}.posthog.com', slot: 'dc' },
  auth: {
    kind: 'bearer',
    secretName: 'POSTHOG_PERSONAL_API_KEY',
    tokenHelp:
      'Create a personal API key with Query Read access under Settings, Personal API keys in PostHog.',
  },
  endpoints: [
    {
      id: 'run-query',
      displayName: 'Ask your analytics',
      method: 'POST',
      path: '/api/projects/{project_id}/query/',
      // POST on the wire, but HogQL SELECTs change nothing, so the class is read.
      class: 'read',
      params: {
        project_id: {
          type: 'string',
          required: true,
          help: 'Your PostHog project id, shown in project settings.',
        },
        query: {
          type: 'string',
          required: true,
          at: 'query.query',
          help: "The question as SQL, like SELECT count() FROM events WHERE event = 'signup'.",
        },
      },
      body: 'json',
      bodyConstants: { 'query.kind': 'HogQLQuery' },
      picks: [
        // results is rows-of-cells; the first cell of the first row is the single-number answer.
        { field: 'value', from: 'results.0.0' },
        { field: 'column', from: 'columns.0' },
      ],
    },
  ],
  inside: {
    tables: [
      {
        name: 'metrics',
        displayName: 'Metrics',
        rowSchema: { query: 'string', value: 'number', column: 'string' },
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
      help: 'The PostHog project your app reads from.',
    },
    {
      id: 'default_query',
      label: 'Question',
      kind: 'text',
      help: 'The number this app shows, as a SQL question.',
    },
  ],
  fixtures: [
    {
      endpoint: 'run-query',
      params: { project_id: '12345', query: 'SELECT count() FROM events' },
      status: 200,
      response: { columns: ['count()'], results: [[8500]], types: ['UInt64'] },
    },
  ],
};
