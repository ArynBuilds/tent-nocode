import type { IntegrationDefInput as IntegrationDef } from '../catalog.js';

// Mixpanel integration def: query/export read lane with service-account basic auth.
// The ingestion lane (/track, /import) cannot ride this auth/body grammar and is excluded.
export const mixpanel: IntegrationDef = {
  name: 'mixpanel', version: 1,
  displayName: 'Mixpanel',
  blurb: 'Read your own Mixpanel analytics in your app - top events, counts over time, and raw event history.',
  category: 'analytics', surfaces: 'both', scope: 'builder',
  hosts: ['https://mixpanel.com', 'https://data.mixpanel.com'],
  auth: {
    // Service-account username:secret held as one vault value.
    kind: 'basic',
    secretName: 'MIXPANEL_SERVICE_ACCOUNT',
    tokenHelp: 'Create a service account under Organization Settings in Mixpanel, then join its username and secret with a colon: Username:Secret. Save the secret at creation - Mixpanel never shows it again.',
  },
  endpoints: [
    {
      id: 'top-events', displayName: "See today's top events", method: 'GET', path: '/api/query/events/top',
      class: 'read',
      params: {
        project_id: { type: 'number', required: true, help: 'Your Mixpanel project number, shown in project settings. An identifier, not a secret.' },
        type: { type: 'string', required: true, choices: ['general', 'unique', 'average'], help: 'How to count: every firing, unique users, or the average.' },
        limit: { type: 'number', help: 'How many events to bring back. Mixpanel defaults to 100.' },
      },
      // Pick names differ from param names on purpose: only this call feeds the inside table.
      picks: [
        { field: 'top_event', from: 'events.0.event' },
        { field: 'event_count', from: 'events.0.amount' },
      ],
    },
    {
      id: 'segmentation', displayName: 'Count an event over days', method: 'GET', path: '/api/query/segmentation',
      class: 'read',
      params: {
        project_id: { type: 'number', required: true, help: 'Your Mixpanel project number, shown in project settings.' },
        event: { type: 'string', required: true, help: 'The event to count, like Signed up.' },
        from_date: { type: 'string', required: true, help: 'First day, like 2026-08-01. Inclusive.' },
        to_date: { type: 'string', required: true, help: 'Last day, like 2026-08-15. Inclusive.' },
        unit: { type: 'string', choices: ['minute', 'hour', 'day', 'month'], help: 'The bucket size. Mixpanel defaults to day.' },
        type: { type: 'string', choices: ['general', 'unique', 'average'], help: 'How to count: every firing, unique users, or the average.' },
      },
      // Answer keys values by event name and date, so no dot-path picks exist.
    },
    {
      id: 'export-events', displayName: 'Download raw events', method: 'GET', path: '/api/2.0/export',
      host: 'https://data.mixpanel.com',
      class: 'read',
      params: {
        project_id: { type: 'number', required: true, help: 'Your Mixpanel project number, shown in project settings.' },
        from_date: { type: 'string', required: true, help: 'First day, like 2026-08-01. Inclusive, UTC.' },
        to_date: { type: 'string', required: true, help: 'Last day, like 2026-08-15. Inclusive, UTC.' },
        limit: { type: 'number', help: 'At most this many events. Mixpanel caps this at 100000.' },
        event: { type: 'string', help: 'Only these events, written as a list like ["Signed up","Purchase"]. Leave empty for all.' },
      },
      // Answer is one event per line, plain text.
    },
  ],
  inside: {
    // Only the top-events call lands rows; segmentation and export append nothing.
    tables: [{ name: 'top-events', displayName: 'Top events', rowSchema: { 'top-event': 'string', 'event-count': 'number' }, grain: 'app' }],
    watchers: [],
  },
  settings: [
    { id: 'project_id', label: 'Project number', kind: 'number', help: 'From your Mixpanel project settings. Fills every call, so wires need nothing extra.' },
    { id: 'default_type', label: 'Count as', kind: 'enum', choices: ['general', 'unique', 'average'], help: 'The default way to count events.' },
    { id: 'default_event', label: 'Event name', kind: 'text', help: 'The event your app counts by default, like Signed up.' },
  ],
  fixtures: [
    {
      endpoint: 'top-events',
      params: { project_id: 12345, type: 'unique' },
      status: 200,
      response: { events: [{ amount: 2, event: 'funnel', percent_change: -0.35635745999582824 }], type: 'unique' },
    },
    {
      endpoint: 'segmentation',
      params: { project_id: 12345, event: 'splash features', from_date: '2011-08-06', to_date: '2011-08-08' },
      status: 200,
      response: {
        data: {
          series: ['2011-08-06', '2011-08-07', '2011-08-08'],
          values: { 'splash features': { '2011-08-06': 136, '2011-08-07': 147, '2011-08-08': 146 } },
        },
        legend_size: 1,
      },
    },
    {
      endpoint: 'export-events',
      params: { project_id: 12345, from_date: '2020-10-01', to_date: '2020-10-02' },
      status: 200,
      response: '{"event":"Signed up","properties":{"time":1602611311,"$insert_id":"hpuDqcvpltpCjBsebtxwadtEBDnFAdycabFb","mp_processing_time_ms":1602625711874}}\n{"event":"Signed up","properties":{"time":1602787121,"$insert_id":"jajcebutltmvhbbholfhxtCcycwnBjDtndha","mp_processing_time_ms":1602801521561}}',
    },
  ],
};
