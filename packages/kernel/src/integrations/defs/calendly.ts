import type { IntegrationDefInput as IntegrationDef } from '../catalog.js';

// Calendly reads; GET /users/me answers the user URI every scheduled-events read requires.
export const calendly: IntegrationDef = {
  name: 'calendly',
  version: 1,
  displayName: 'Calendly',
  blurb: 'Bring the bookings from your Calendly account into your app to read and show.',
  category: 'data',
  surfaces: 'both',
  scope: 'builder',
  hosts: ['https://api.calendly.com'],
  auth: {
    kind: 'bearer',
    secretName: 'CALENDLY_API_TOKEN',
    tokenHelp: 'In Calendly go to Integrations, then API and Webhooks, and generate a personal access token. Copy it right away - Calendly never shows it again.',
  },
  endpoints: [
    {
      id: 'get-current-user',
      displayName: 'Look up your account',
      method: 'GET',
      path: '/users/me',
      class: 'read',
      params: {},
      picks: [
        { field: 'user', from: 'resource.uri' },
        { field: 'user_name', from: 'resource.name' },
        { field: 'scheduling_url', from: 'resource.scheduling_url' },
      ],
    },
    {
      id: 'list-scheduled-events',
      displayName: 'Read your scheduled events',
      method: 'GET',
      path: '/scheduled_events',
      class: 'read',
      params: {
        user: {
          type: 'string',
          required: true,
          help: 'Your user address. Run Look up your account first - its user value is exactly what goes here. Fill the Your user address setting once and every read uses it.',
        },
        status: {
          type: 'string',
          choices: ['active', 'canceled'],
          help: 'Pick active to keep canceled bookings out.',
        },
        min_start_time: {
          type: 'string',
          help: 'Only events starting at or after this moment, like 2026-08-15T00:00:00Z.',
        },
        max_start_time: {
          type: 'string',
          help: 'Only events starting before this moment.',
        },
        invitee_email: {
          type: 'string',
          help: 'Only events booked by this email address.',
        },
        count: {
          type: 'number',
          help: 'How many events per read, up to 100.',
        },
        sort: {
          type: 'string',
          choices: ['start_time:asc', 'start_time:desc'],
          help: 'Soonest first or latest first.',
        },
      },
      picks: [
        { field: 'event_name', from: 'collection.0.name' },
        { field: 'event_status', from: 'collection.0.status' },
        { field: 'start_time', from: 'collection.0.start_time' },
        { field: 'end_time', from: 'collection.0.end_time' },
        { field: 'event_uri', from: 'collection.0.uri' },
      ],
    },
  ],
  inside: {
    // Bookings pull once per app.
    tables: [
      {
        name: 'scheduled-events',
        displayName: 'Scheduled events',
        rowSchema: {
          'event-name': 'string',
          'event-status': 'string',
          'start-time': 'string',
          'end-time': 'string',
          'event-uri': 'string',
        },
        grain: 'app',
      },
    ],
    watchers: [],
  },
  settings: [
    {
      id: 'user',
      label: 'Your user address',
      kind: 'text',
      help: 'Run Look up your account and paste its user value here. Every scheduled-events read fills from it.',
    },
    {
      id: 'default_status',
      label: 'Which bookings',
      kind: 'enum',
      choices: ['active', 'canceled'],
      help: 'What every read pulls unless a call says otherwise.',
    },
  ],
  // Webhook triggers; the body's top-level 'event' names the fire.
  triggers: [
    { kind: 'webhook', id: 'booking-created', displayName: 'Booking created', eventPath: 'event', events: ['invitee.created'] },
    { kind: 'webhook', id: 'booking-canceled', displayName: 'Booking canceled', eventPath: 'event', events: ['invitee.canceled'] },
  ],
  fixtures: [
    {
      endpoint: 'get-current-user',
      params: {},
      status: 200,
      response: {
        resource: {
          uri: 'https://api.calendly.com/users/AAAAAAAAAAAAAAAA',
          name: 'John Doe',
          slug: 'johndoe',
          email: 'user@example.com',
          scheduling_url: 'https://calendly.com/johndoe',
          timezone: 'America/New_York',
          current_organization: 'https://api.calendly.com/organizations/AAAAAAAAAAAAAAAA',
        },
      },
    },
    {
      endpoint: 'list-scheduled-events',
      params: { user: 'https://api.calendly.com/users/AAAAAAAAAAAAAAAA', status: 'active' },
      status: 200,
      response: {
        collection: [
          {
            uri: 'https://api.calendly.com/scheduled_events/GBGBDCAADAEDCRZ2',
            name: '30 Minute Meeting',
            status: 'active',
            start_time: '2026-08-20T10:00:00.000000Z',
            end_time: '2026-08-20T10:30:00.000000Z',
            event_type: 'https://api.calendly.com/event_types/GBGBDCAADAEDCRZ2',
            created_at: '2026-08-10T08:00:00.000000Z',
            updated_at: '2026-08-10T08:00:00.000000Z',
          },
        ],
        pagination: { count: 1, next_page: null },
      },
    },
  ],
};
