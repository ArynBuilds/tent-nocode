import type { IntegrationDefInput as IntegrationDef } from '../catalog.js';

// Google Analytics data API read-only report lane; response nests values in arrays.
export const googleAnalytics: IntegrationDef = {
  name: 'google-analytics',
  version: 1,
  displayName: 'Google Analytics',
  blurb: 'Bring your Google Analytics visitor numbers into your app from your own GA4 property.',
  category: 'analytics',
  surfaces: 'both',
  scope: 'builder',
  availability: 'upcoming',
  hosts: ['https://analyticsdata.googleapis.com'],
  auth: {
    kind: 'oauth',
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scopes: ['https://www.googleapis.com/auth/analytics.readonly'],
    clientEnv: 'GOOGLE',
    tokenHelp: 'Sign in with the Google account that can view your GA4 property - nothing to paste.',
  },
  endpoints: [
    {
      id: 'run-report',
      displayName: 'Run a report',
      method: 'POST',
      path: '/v1beta/properties/{property_id}:runReport',
      // POST on the wire but changes nothing.
      class: 'read',
      params: {
        property_id: {
          type: 'string',
          required: true,
          help: 'Your GA4 property number, shown under Admin then Property settings.',
        },
        metric: {
          type: 'string',
          required: true,
          at: 'metrics.0.name',
          help: 'What to count, like activeUsers or screenPageViews.',
        },
        dimension: {
          type: 'string',
          at: 'dimensions.0.name',
          help: 'How to split the numbers, like country, city, or date.',
        },
        start_date: {
          type: 'string',
          required: true,
          at: 'dateRanges.0.startDate',
          help: 'Like 28daysAgo or 2026-01-01.',
        },
        end_date: {
          type: 'string',
          required: true,
          at: 'dateRanges.0.endDate',
          help: 'Like today or 2026-01-31.',
        },
      },
      body: 'json',
      picks: [
        { field: 'value', from: 'rows.0.metricValues.0.value' },
        { field: 'label', from: 'rows.0.dimensionValues.0.value' },
        { field: 'row_count', from: 'rowCount' },
      ],
    },
  ],
  inside: {
    tables: [
      {
        name: 'report',
        displayName: 'Report',
        // One row per call: metric/dimension from params, first-row answer from picks.
        rowSchema: { metric: 'string', dimension: 'string', label: 'string', value: 'number' },
        grain: 'app',
      },
    ],
    watchers: [],
  },
  settings: [
    { id: 'default_property_id', label: 'Property', kind: 'text', help: 'The GA4 property this app reads from.' },
    { id: 'default_metric', label: 'What to count', kind: 'text', help: 'The number this app shows, like activeUsers.' },
    { id: 'default_dimension', label: 'Split by', kind: 'text', help: 'Optional - like country or date.' },
    { id: 'default_start_date', label: 'From', kind: 'text', help: 'Like 28daysAgo.' },
    { id: 'default_end_date', label: 'To', kind: 'text', help: 'Like today.' },
  ],
  fixtures: [
    {
      endpoint: 'run-report',
      params: {
        property_id: '123456789',
        metric: 'activeUsers',
        dimension: 'city',
        start_date: '2026-01-01',
        end_date: '2026-01-31',
      },
      status: 200,
      response: {
        dimensionHeaders: [{ name: 'city' }],
        metricHeaders: [{ name: 'activeUsers', type: 'TYPE_INTEGER' }],
        rows: [
          { dimensionValues: [{ value: 'Tokyo' }], metricValues: [{ value: '2541' }] },
          { dimensionValues: [{ value: 'Osaka' }], metricValues: [{ value: '827' }] },
        ],
        rowCount: 2,
        metadata: { currencyCode: 'USD', timeZone: 'America/Los_Angeles' },
        kind: 'analyticsData#runReport',
      },
    },
  ],
};
