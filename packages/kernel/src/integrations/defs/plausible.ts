import type { IntegrationDefInput as IntegrationDef } from '../catalog.js';

// Plausible Analytics Stats API v2 def; metrics is a fixed array set via bodyConstants dot-paths.
export const plausible: IntegrationDef = {
  name: 'plausible',
  version: 1,
  displayName: 'Plausible',
  blurb: 'Bring your site visitor and pageview numbers into your app from your own Plausible account.',
  category: 'data',
  surfaces: 'both',
  scope: 'builder',
  hosts: ['https://plausible.io'],
  auth: {
    kind: 'bearer',
    secretName: 'PLAUSIBLE_API_KEY',
    tokenHelp: 'Create a Stats API key under Settings, then API Keys, in your Plausible account.',
  },
  endpoints: [
    {
      id: 'query-traffic',
      displayName: 'Look up traffic numbers',
      method: 'POST',
      path: '/api/v2/query',
      class: 'read',
      body: 'json',
      // Fixed metric list: visitors + pageviews.
      bodyConstants: {
        'metrics.0': 'visitors',
        'metrics.1': 'pageviews',
      },
      params: {
        site_id: {
          type: 'string',
          required: true,
          help: 'Your site domain exactly as added to Plausible, like example.com.',
        },
        date_range: {
          type: 'string',
          required: true,
          choices: ['day', '7d', '28d', '30d', '91d', 'month', '6mo', '12mo', 'year', 'all'],
          help: 'How far back to count.',
        },
      },
      // Aggregate query returns one row with metrics in request order.
      picks: [
        { field: 'visitors', from: 'results.0.metrics.0' },
        { field: 'pageviews', from: 'results.0.metrics.1' },
      ],
    },
  ],
  inside: {
    // Traffic pulls once per app; every user reads the same row.
    tables: [
      {
        name: 'traffic',
        displayName: 'Traffic',
        rowSchema: {
          'site-id': 'string',
          'date-range': 'string',
          visitors: 'number',
          pageviews: 'number',
        },
        grain: 'app',
      },
    ],
    watchers: [],
  },
  settings: [
    // site_id fills the matching param; default_date_range fills date_range when unset.
    { id: 'site_id', label: 'Site', kind: 'text', help: 'The domain your Plausible dashboard tracks.' },
    {
      id: 'default_date_range',
      label: 'Time window',
      kind: 'enum',
      choices: ['day', '7d', '28d', '30d', '91d', 'month', '6mo', '12mo', 'year', 'all'],
      help: 'How far back to count when the app does not say.',
    },
  ],
  fixtures: [
    {
      endpoint: 'query-traffic',
      params: { site_id: 'dummy.site', date_range: '7d' },
      status: 200,
      response: {
        results: [{ metrics: [99, 98], dimensions: [] }],
        meta: {},
        query: {
          site_id: 'dummy.site',
          metrics: ['visitors', 'pageviews'],
          date_range: ['2024-09-04T00:00:00+00:00', '2024-09-10T23:59:59+00:00'],
          filters: [],
          dimensions: [],
          order_by: [],
          include: {},
        },
      },
    },
  ],
};
