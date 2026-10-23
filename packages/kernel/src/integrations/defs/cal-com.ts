import type { IntegrationDefInput as IntegrationDef } from '../catalog.js';

// Cal.com scheduling (v2 API); each endpoint needs its own constant cal-api-version header value.
export const calCom: IntegrationDef = {
  name: 'cal-com',
  version: 1,
  displayName: 'Cal.com',
  blurb: 'Bring the bookings from your Cal.com account into your app, and let your app book meetings.',
  category: 'scheduling',
  surfaces: 'both',
  scope: 'builder',
  hosts: ['https://api.cal.com'],
  auth: {
    kind: 'bearer',
    secretName: 'CAL_COM_API_KEY',
    tokenHelp: 'In Cal.com go to Settings, then Developer, then API keys, and create a key. Copy it right away.',
  },
  endpoints: [
    {
      id: 'get-bookings',
      displayName: 'Read your bookings',
      method: 'GET',
      path: '/v2/bookings',
      class: 'read',
      headers: { 'cal-api-version': '2026-05-01' },
      params: {
        status: {
          type: 'string',
          choices: ['upcoming', 'recurring', 'past', 'cancelled', 'unconfirmed'],
          help: 'Which bookings to list, like upcoming.',
        },
        attendee_email: {
          type: 'string',
          wire: 'attendeeEmail',
          help: 'Only bookings with this attendee email.',
        },
        event_type_id: {
          type: 'number',
          wire: 'eventTypeId',
          help: 'Only bookings of this event type.',
        },
        after_start: {
          type: 'string',
          wire: 'afterStart',
          help: 'Only bookings starting after this moment, like 2026-08-15T00:00:00Z.',
        },
        before_end: {
          type: 'string',
          wire: 'beforeEnd',
          help: 'Only bookings ending before this moment.',
        },
        limit: {
          type: 'number',
          help: 'How many bookings per read, 1 to 100.',
        },
      },
      picks: [
        { field: 'uid', from: 'data.0.uid' },
        { field: 'title', from: 'data.0.title' },
        { field: 'start', from: 'data.0.start' },
        { field: 'end', from: 'data.0.end' },
        { field: 'booking_status', from: 'data.0.status' },
        { field: 'attendee_name', from: 'data.0.attendees.0.name' },
      ],
    },
    {
      id: 'create-booking',
      displayName: 'Book a meeting',
      method: 'POST',
      path: '/v2/bookings',
      class: 'write',
      headers: { 'cal-api-version': '2026-02-25' },
      params: {
        start: {
          type: 'string',
          required: true,
          help: 'When the meeting starts, in UTC, like 2026-08-20T09:00:00Z.',
        },
        event_type_id: {
          type: 'number',
          required: true,
          wire: 'eventTypeId',
          help: 'Which of your Cal.com event types is being booked.',
        },
        attendee_name: {
          type: 'string',
          required: true,
          at: 'attendee.name',
          help: 'Who the meeting is for.',
        },
        attendee_email: {
          type: 'string',
          required: true,
          at: 'attendee.email',
          help: 'Where the booking confirmation goes.',
        },
        attendee_time_zone: {
          type: 'string',
          required: true,
          at: 'attendee.timeZone',
          help: 'The attendee time zone, like Europe/Istanbul.',
        },
        attendee_phone: {
          type: 'string',
          at: 'attendee.phoneNumber',
          help: 'A phone number for the attendee, with country code.',
        },
        length_in_minutes: {
          type: 'number',
          wire: 'lengthInMinutes',
          help: 'Meeting length, when the event type allows more than one.',
        },
      },
      body: 'json',
      picks: [
        { field: 'uid', from: 'data.uid' },
        { field: 'title', from: 'data.title' },
        { field: 'end', from: 'data.end' },
        { field: 'booking_status', from: 'data.status' },
      ],
    },
  ],
  inside: {
    // Bookings pull once per app; columns fill by name from call params then picks.
    tables: [
      {
        name: 'bookings',
        displayName: 'Bookings',
        rowSchema: {
          uid: 'string',
          title: 'string',
          start: 'string',
          end: 'string',
          'booking-status': 'string',
          'attendee-name': 'string',
          'attendee-email': 'string',
        },
        grain: 'app',
      },
    ],
    watchers: [],
  },
  settings: [
    {
      id: 'default_event_type_id',
      label: 'Event type',
      kind: 'number',
      help: 'The Cal.com event type your app books when a call does not name one.',
    },
    {
      id: 'default_attendee_time_zone',
      label: 'Time zone',
      kind: 'text',
      help: 'The time zone used for attendees when none is given, like Europe/Istanbul.',
    },
  ],
  fixtures: [
    {
      endpoint: 'get-bookings',
      params: { status: 'upcoming', limit: 50 },
      status: 200,
      response: {
        status: 'success',
        data: [
          {
            id: 123,
            uid: 'booking_uid_123',
            title: 'Consultation',
            description: 'Learn how to integrate scheduling into marketplace.',
            status: 'accepted',
            start: '2024-08-13T15:30:00Z',
            end: '2024-08-13T16:30:00Z',
            duration: 60,
            eventTypeId: 50,
            eventType: { id: 1, slug: 'some-event' },
            location: 'https://example.com/meeting',
            attendees: [
              {
                name: 'John Doe',
                email: 'john@example.com',
                timeZone: 'America/New_York',
                absent: false,
              },
            ],
            createdAt: '2024-08-13T15:30:00Z',
            updatedAt: '2024-08-13T15:30:00Z',
          },
        ],
        pagination: { hasMore: false },
      },
    },
    {
      endpoint: 'create-booking',
      params: {
        start: '2024-08-13T09:00:00Z',
        event_type_id: 123,
        attendee_name: 'John Doe',
        attendee_email: 'john@example.com',
        attendee_time_zone: 'America/New_York',
      },
      status: 201,
      response: {
        status: 'success',
        data: {
          id: 123,
          uid: 'booking_uid_123',
          title: 'Consultation',
          description: 'Learn how to integrate scheduling into marketplace.',
          start: '2024-08-13T15:30:00Z',
          end: '2024-08-13T16:30:00Z',
          duration: 60,
          status: 'accepted',
          location: 'https://example.com/meeting',
          eventType: { id: 50, slug: 'some-event' },
          attendees: [
            {
              name: 'John Doe',
              email: 'john@example.com',
              timeZone: 'America/New_York',
              absent: false,
            },
          ],
          createdAt: '2024-08-13T15:30:00Z',
          updatedAt: '2024-08-13T15:30:00Z',
        },
      },
    },
  ],
};
