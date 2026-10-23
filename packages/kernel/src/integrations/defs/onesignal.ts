// OneSignal integration def: web push sends from the builder's own OneSignal app.
// included_segments.0 carries exactly one segment per send.
import type { IntegrationDefInput as IntegrationDef } from '../catalog.js';

export const onesignal: IntegrationDef = {
  name: 'onesignal',
  version: 1,
  displayName: 'OneSignal',
  blurb: 'Send web push notifications to your visitors through your own OneSignal account.',
  category: 'push',
  surfaces: 'website',
  scope: 'builder',
  hosts: ['https://api.onesignal.com'],
  auth: {
    // Authorization header with the `Key` scheme.
    kind: 'bearer',
    scheme: 'Key',
    secretName: 'ONESIGNAL_REST_API_KEY',
    tokenHelp: 'Your app REST API key, under Settings, then Keys and IDs, in the OneSignal dashboard. It is shown once when created.',
  },
  endpoints: [
    {
      id: 'send-push',
      displayName: 'Send a push notification',
      method: 'POST',
      path: '/notifications',
      class: 'send',
      body: 'json',
      // Pins the create to the push channel.
      bodyConstants: { target_channel: 'push' },
      params: {
        app_id: { type: 'string', required: true, help: 'Your OneSignal App ID, under Settings, then Keys and IDs. Set it once in the node settings.' },
        segment: { type: 'string', required: true, at: 'included_segments.0', help: 'The OneSignal segment that receives it, like Subscribed Users.' },
        message: { type: 'string', required: true, at: 'contents.en', help: 'The notification text.' },
        title: { type: 'string', at: 'headings.en', help: 'The bold title line above the message.' },
        url: { type: 'string', help: 'Where a click on the notification takes people.' },
      },
      picks: [{ field: 'id', from: 'id' }],
    },
  ],
  inside: {
    // Every sent push lands here.
    tables: [
      {
        name: 'sent-pushes',
        displayName: 'Sent notifications',
        rowSchema: { segment: 'string', title: 'string', message: 'string', id: 'string' },
        grain: 'app',
      },
    ],
    watchers: [],
  },
  settings: [
    // Settings fill their matching params when the caller leaves them unset.
    { id: 'app_id', label: 'App', kind: 'text', help: 'Your OneSignal App ID, under Settings, then Keys and IDs.' },
    { id: 'default_segment', label: 'Segment', kind: 'text', help: 'Who your app sends to by default, like Subscribed Users.' },
    { id: 'default_title', label: 'Title', kind: 'text', help: 'The title your notifications carry by default.' },
    { id: 'default_message', label: 'Message', kind: 'template', help: 'The message with field slots, or bind an input on screen.' },
  ],
  fixtures: [
    {
      endpoint: 'send-push',
      params: {
        app_id: 'b2f7f966-d8cc-11e4-bed1-df8f05be55ba',
        segment: 'Subscribed Users',
        message: 'Hello, world',
        title: 'Fresh news',
      },
      status: 200,
      response: { id: 'b98881cc-1e94-4366-bbd9-db8f3429292b', external_id: null },
    },
  ],
};
