import type { IntegrationDefInput as IntegrationDef } from '../catalog.js';

// Klaviyo JSON:API marketing platform; requests carry pinned revision + content-type headers.
export const klaviyo: IntegrationDef = {
  name: 'klaviyo', version: 1,
  displayName: 'Klaviyo',
  blurb: 'Add people and track what they do in your own Klaviyo account.',
  category: 'marketing', surfaces: 'both', scope: 'builder',
  hosts: ['https://a.klaviyo.com'],
  auth: {
    kind: 'bearer', scheme: 'Klaviyo-API-Key',
    secretName: 'KLAVIYO_API_KEY',
    tokenHelp: 'Create a private API key under Settings, then API keys in your Klaviyo account.',
  },
  headers: {
    revision: '2026-07-15',
    'content-type': 'application/vnd.api+json',
  },
  endpoints: [
    {
      id: 'create-profile', displayName: 'Add a person', method: 'POST', path: '/api/profiles',
      class: 'write',
      body: 'json',
      bodyConstants: { 'data.type': 'profile' },
      params: {
        email: { type: 'string', required: true, at: 'data.attributes.email', help: 'The address that identifies this person in Klaviyo.' },
        phone_number: { type: 'string', at: 'data.attributes.phone_number', help: 'In international format, like +15005550006.' },
        first_name: { type: 'string', at: 'data.attributes.first_name' },
        last_name: { type: 'string', at: 'data.attributes.last_name' },
        organization: { type: 'string', at: 'data.attributes.organization' },
        title: { type: 'string', at: 'data.attributes.title' },
      },
      picks: [
        { field: 'id', from: 'data.id' },
        { field: 'email', from: 'data.attributes.email' },
      ],
    },
    {
      id: 'create-event', displayName: 'Track an event', method: 'POST', path: '/api/events',
      class: 'write',
      body: 'json',
      bodyConstants: {
        'data.type': 'event',
        'data.attributes.metric.data.type': 'metric',
        'data.attributes.profile.data.type': 'profile',
      },
      params: {
        metric_name: { type: 'string', required: true, at: 'data.attributes.metric.data.attributes.name', help: 'What happened, like Viewed Product.' },
        email: { type: 'string', required: true, at: 'data.attributes.profile.data.attributes.email', help: 'Whose event this is.' },
        value: { type: 'number', at: 'data.attributes.value', help: 'A number worth tracking with the event, like an order total.' },
        time: { type: 'string', at: 'data.attributes.time', help: 'When it happened, like 2026-08-15T12:00:00+00:00. Leave empty for now.' },
      },
    },
  ],
  inside: {
    tables: [
      { name: 'profiles', displayName: 'People', rowSchema: { email: 'string', 'first-name': 'string', 'last-name': 'string', id: 'string' }, grain: 'app' },
      { name: 'events', displayName: 'Events', rowSchema: { 'metric-name': 'string', email: 'string', value: 'number' }, grain: 'app' },
    ],
    watchers: [],
  },
  settings: [
    { id: 'default_metric_name', label: 'Event name', kind: 'text', help: 'The event your app tracks by default, like Signed Up.' },
  ],
  fixtures: [
    {
      endpoint: 'create-profile',
      params: { email: 'sarah.mason@klaviyo-demo.com', first_name: 'Sarah', last_name: 'Mason' },
      status: 201,
      response: {
        data: {
          type: 'profile',
          id: '01GDDKASAP8TKDDA2GRZDSVP4H',
          attributes: {
            email: 'sarah.mason@klaviyo-demo.com',
            first_name: 'Sarah',
            last_name: 'Mason',
            created: '2026-08-15T00:00:00+00:00',
            updated: '2026-08-15T00:00:00+00:00',
          },
        },
      },
    },
    {
      endpoint: 'create-event',
      params: { metric_name: 'Viewed Product', email: 'sarah.mason@klaviyo-demo.com', value: 9.99 },
      status: 202,
      response: {},
    },
  ],
};
