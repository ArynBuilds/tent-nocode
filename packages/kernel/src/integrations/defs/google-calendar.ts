import type { IntegrationDefInput as IntegrationDef } from '../catalog.js';

// Google Calendar mirror and event add; only id/summary/status land due to nested times and camelCase mismatch.
export const googleCalendar: IntegrationDef = {
  name: 'google-calendar',
  version: 1,
  displayName: 'Google Calendar',
  blurb: 'Mirror a Google Calendar into a Table and add events to it from your app.',
  category: 'scheduling',
  availability: 'upcoming',
  surfaces: 'both',
  scope: 'both',
  hosts: ['https://www.googleapis.com'],
  auth: {
    kind: 'oauth',
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scopes: ['https://www.googleapis.com/auth/calendar.events'],
    clientEnv: 'GOOGLE',
    tokenHelp:
      'Click Sign in to Google Calendar and allow event access - there is no key to copy.',
  },
  endpoints: [
    {
      id: 'list-events',
      displayName: 'Read events',
      method: 'GET',
      path: '/calendar/v3/calendars/{calendar_id}/events',
      class: 'read',
      params: {
        calendar_id: {
          type: 'string',
          required: true,
          help: "Which calendar to read - 'primary' is your main calendar.",
        },
        max_results: {
          type: 'number',
          wire: 'maxResults',
          help: 'How many events to read per pull, up to 2500.',
        },
        time_min: {
          type: 'string',
          wire: 'timeMin',
          help: 'Only events ending after this moment, like 2026-08-15T00:00:00Z.',
        },
      },
      picks: [{ field: 'next_page_token', from: 'nextPageToken' }],
    },
    {
      id: 'create-event',
      displayName: 'Add an event',
      method: 'POST',
      path: '/calendar/v3/calendars/{calendar_id}/events',
      class: 'write',
      body: 'json',
      params: {
        calendar_id: {
          type: 'string',
          required: true,
          help: "Which calendar the event lands in - 'primary' is your main calendar.",
        },
        summary: {
          type: 'string',
          required: true,
          help: 'The event title.',
        },
        start_datetime: {
          type: 'string',
          required: true,
          at: 'start.dateTime',
          help: 'When the event starts, with its UTC offset - like 2026-08-20T10:00:00+03:00.',
        },
        end_datetime: {
          type: 'string',
          required: true,
          at: 'end.dateTime',
          help: 'When the event ends, with its UTC offset - like 2026-08-20T11:00:00+03:00.',
        },
      },
      picks: [
        { field: 'id', from: 'id' },
        { field: 'summary', from: 'summary' },
        { field: 'status', from: 'status' },
      ],
    },
  ],
  inside: {
    tables: [
      {
        name: 'events',
        displayName: 'Events',
        rowSchema: {
          id: 'string',
          summary: 'string',
          status: 'string',
        },
        grain: 'app',
        fromArray: 'items',
      },
    ],
    watchers: [],
  },
  sync: { endpoint: 'list-events', everyMinutes: 30 },
  settings: [
    {
      id: 'calendar_id',
      label: 'Calendar',
      kind: 'text',
      help: "The calendar this node mirrors and adds events to. 'primary' means your main calendar - the usual pick.",
    },
  ],
  triggers: [
    { kind: 'poll', id: 'event-changed', displayName: 'Event added or changed', table: 'events' },
  ],
  fixtures: [
    {
      endpoint: 'list-events',
      params: { calendar_id: 'primary', max_results: 2 },
      status: 200,
      response: {
        kind: 'calendar#events',
        summary: 'Work',
        updated: '2026-08-14T16:20:11.000Z',
        timeZone: 'Europe/Istanbul',
        accessRole: 'owner',
        items: [
          {
            kind: 'calendar#event',
            id: '0kml6fsan9q2iv0adhusmi9pmg',
            status: 'confirmed',
            htmlLink: 'https://www.google.com/calendar/event?eid=MGttbDZmc2FuOXEyaXYwYWRodXNtaTlwbWc',
            created: '2026-08-01T09:15:00.000Z',
            updated: '2026-08-01T09:15:00.000Z',
            summary: 'Team Meeting',
            start: { dateTime: '2026-08-20T10:00:00+03:00', timeZone: 'Europe/Istanbul' },
            end: { dateTime: '2026-08-20T11:00:00+03:00', timeZone: 'Europe/Istanbul' },
          },
          {
            kind: 'calendar#event',
            id: '4qsfp0f8vt3g2b1n6c5h8j7d2k',
            status: 'tentative',
            htmlLink: 'https://www.google.com/calendar/event?eid=NHFzZnAwZjh2dDNnMmIxbjZjNWg4ajdkMms',
            created: '2026-08-10T12:00:00.000Z',
            updated: '2026-08-12T08:30:00.000Z',
            summary: 'Design review',
            start: { dateTime: '2026-08-21T14:00:00+03:00', timeZone: 'Europe/Istanbul' },
            end: { dateTime: '2026-08-21T15:00:00+03:00', timeZone: 'Europe/Istanbul' },
          },
        ],
      },
    },
    {
      endpoint: 'create-event',
      params: {
        calendar_id: 'primary',
        summary: 'Team Meeting',
        start_datetime: '2026-08-20T10:00:00+03:00',
        end_datetime: '2026-08-20T11:00:00+03:00',
      },
      status: 200,
      response: {
        kind: 'calendar#event',
        id: '0kml6fsan9q2iv0adhusmi9pmg',
        status: 'confirmed',
        htmlLink: 'https://www.google.com/calendar/event?eid=MGttbDZmc2FuOXEyaXYwYWRodXNtaTlwbWc',
        created: '2026-08-15T09:10:04.000Z',
        updated: '2026-08-15T09:10:04.000Z',
        summary: 'Team Meeting',
        start: { dateTime: '2026-08-20T10:00:00+03:00', timeZone: 'Europe/Istanbul' },
        end: { dateTime: '2026-08-20T11:00:00+03:00', timeZone: 'Europe/Istanbul' },
      },
    },
  ],
};
