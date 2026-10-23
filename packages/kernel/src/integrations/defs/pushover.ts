import type { IntegrationDefInput as IntegrationDef } from '../catalog.js';

export const pushover: IntegrationDef = {
  name: 'pushover',
  version: 1,
  displayName: 'Pushover',
  blurb: 'Send push notifications to your phone through your own Pushover account.',
  category: 'messaging',
  surfaces: 'both',
  scope: 'builder',
  hosts: ['https://api.pushover.net'],
  auth: {
    kind: 'body',
    at: 'token',
    secretName: 'PUSHOVER_APP_TOKEN',
    tokenHelp: 'Create an application on the Pushover site under Your Applications and copy its API token.',
  },
  endpoints: [
    {
      id: 'send-message',
      displayName: 'Send a notification',
      method: 'POST',
      path: '/1/messages.json',
      class: 'send',
      body: 'json',
      params: {
        user: {
          type: 'string',
          required: true,
          help: 'The user or group key of who receives the notification, from their Pushover dashboard. It identifies a recipient - it is not an API secret, though it is best kept reasonably private.',
        },
        message: {
          type: 'string',
          required: true,
          help: 'The notification text, up to 1024 characters.',
        },
        title: {
          type: 'string',
          help: 'A short title, up to 250 characters. Without one, the application name shows.',
        },
        url: {
          type: 'string',
          help: 'A link shown under the message, up to 512 characters.',
        },
        url_title: {
          type: 'string',
          help: 'The words shown for the link instead of the raw address, up to 100 characters.',
        },
        priority: {
          type: 'number',
          help: 'From -2 (silent) to 2 (emergency). Emergency notifications repeat until acknowledged and need retry and expire.',
        },
        retry: {
          type: 'number',
          help: 'Emergency only: seconds between repeats, at least 30.',
        },
        expire: {
          type: 'number',
          help: 'Emergency only: seconds until repeating stops, at most 10800.',
        },
        sound: {
          type: 'string',
          help: 'A Pushover sound name, like pushover, bike, siren, or none.',
        },
        device: {
          type: 'string',
          help: 'A device name to reach one device instead of all, comma-separated for several.',
        },
        ttl: {
          type: 'number',
          help: 'Seconds until the notification removes itself from the device.',
        },
      },
      picks: [{ field: 'request', from: 'request' }],
    },
  ],
  inside: {
    tables: [
      {
        name: 'sent-notifications',
        displayName: 'Sent notifications',
        rowSchema: { user: 'string', title: 'string', message: 'string', request: 'string' },
        grain: 'app',
      },
    ],
    watchers: [],
  },
  settings: [
    {
      id: 'default_user',
      label: 'Send to',
      kind: 'text',
      help: 'The user or group key your app notifies by default.',
    },
    {
      id: 'default_message',
      label: 'Message',
      kind: 'template',
      help: 'The message with field slots, or bind an input on screen.',
    },
    {
      id: 'default_title',
      label: 'Title',
      kind: 'text',
      help: 'The title your notifications carry by default.',
    },
  ],
  fixtures: [
    {
      endpoint: 'send-message',
      params: {
        user: 'uQiRzpo4DXghDmr9QzzfQu27cmVRsG',
        message: 'hello world',
        title: 'Order shipped',
      },
      status: 200,
      response: { status: 1, request: '647d2300-702c-4b38-8b2f-d56326ae460b' },
    },
  ],
};
