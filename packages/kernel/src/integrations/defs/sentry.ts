// Sentry read-only def: project issues into an app-grain table; picks read row 0 of the array response.
import type { IntegrationDefInput as IntegrationDef } from '../catalog.js';

export const sentry: IntegrationDef = {
  name: 'sentry',
  version: 1,
  displayName: 'Sentry',
  blurb: 'Read your Sentry project issues into your app to show what is breaking.',
  category: 'observability',
  surfaces: 'both',
  scope: 'builder',
  hosts: ['https://sentry.io'],
  auth: {
    kind: 'bearer',
    secretName: 'SENTRY_AUTH_TOKEN',
    tokenHelp: 'Create a token in Sentry under User settings > Personal Tokens, with the event:read scope.',
  },
  endpoints: [
    {
      id: 'read-project-issues',
      displayName: 'Read project issues',
      method: 'GET',
      // The trailing slash is required.
      path: '/api/0/projects/{org}/{project}/issues/',
      class: 'read',
      params: {
        org: {
          type: 'string',
          required: true,
          help: 'Your Sentry organization slug, as it appears in your Sentry URL.',
        },
        project: {
          type: 'string',
          required: true,
          help: 'The Sentry project slug to read issues from.',
        },
        query: {
          type: 'string',
          help: 'A Sentry search, like is:unresolved. Unset reads unresolved issues.',
        },
        sort: {
          type: 'string',
          choices: ['date', 'new', 'trends', 'freq', 'user', 'inbox'],
          help: 'The order issues come back in. date is newest first.',
        },
        limit: {
          type: 'number',
          help: 'How many issues to read, up to 100. The first one lands in the table.',
        },
      },
      picks: [
        { field: 'id', from: '0.id' },
        { field: 'short_id', from: '0.shortId' },
        { field: 'title', from: '0.title' },
        { field: 'culprit', from: '0.culprit' },
        { field: 'level', from: '0.level' },
        { field: 'status', from: '0.status' },
        { field: 'count', from: '0.count' },
        { field: 'user_count', from: '0.userCount' },
        { field: 'first_seen', from: '0.firstSeen' },
        { field: 'last_seen', from: '0.lastSeen' },
        { field: 'permalink', from: '0.permalink' },
      ],
    },
  ],
  inside: {
    // Issues pull once per app; count coerces from Sentry's numeric string.
    tables: [
      {
        name: 'issues',
        displayName: 'Issues',
        rowSchema: {
          id: 'string',
          'short-id': 'string',
          title: 'string',
          culprit: 'string',
          level: 'string',
          status: 'string',
          count: 'number',
          'user-count': 'number',
          'first-seen': 'string',
          'last-seen': 'string',
          permalink: 'string',
          org: 'string',
          project: 'string',
        },
        grain: 'app',
      },
    ],
    watchers: [],
  },
  settings: [
    {
      id: 'default_org',
      label: 'Organization',
      kind: 'text',
      help: 'Your Sentry organization slug, used when a call names none.',
    },
    {
      id: 'default_project',
      label: 'Project',
      kind: 'text',
      help: 'The Sentry project your app reads by default, by its slug.',
    },
    {
      id: 'default_query',
      label: 'Search',
      kind: 'text',
      help: 'The Sentry search applied when a call names none, like is:unresolved.',
    },
  ],
  fixtures: [
    {
      endpoint: 'read-project-issues',
      params: {
        org: 'the-interstellar-jurisdiction',
        project: 'pump-station',
        query: 'is:unresolved',
        sort: 'date',
        limit: 25,
      },
      status: 200,
      response: [
        {
          annotations: [],
          assignedTo: null,
          count: '1',
          culprit: 'raven.scripts.runner in main',
          firstSeen: '2018-11-06T21:19:55Z',
          hasSeen: false,
          id: '1',
          isBookmarked: false,
          isPublic: false,
          isSubscribed: true,
          lastSeen: '2018-11-06T21:19:55Z',
          level: 'error',
          logger: null,
          metadata: { title: 'This is an example Python exception' },
          numComments: 0,
          permalink: 'https://sentry.io/the-interstellar-jurisdiction/pump-station/issues/1/',
          project: { id: '2', name: 'Pump Station', slug: 'pump-station' },
          shareId: null,
          shortId: 'PUMP-STATION-1',
          stats: {
            '24h': [
              [1541455200, 473],
              [1541458800, 914],
              [1541462400, 991],
            ],
          },
          status: 'unresolved',
          statusDetails: {},
          subscriptionDetails: null,
          title: 'This is an example Python exception',
          type: 'default',
          userCount: 0,
        },
      ],
    },
  ],
};
