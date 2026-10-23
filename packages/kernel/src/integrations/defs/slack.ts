// Slack send-only def: chat.postMessage on the builder's bot token; Slack signals errors as HTTP 200 with ok:false.
import type { IntegrationDefInput as IntegrationDef } from '../catalog.js';

export const slack: IntegrationDef = {
  name: 'slack',
  version: 1,
  displayName: 'Slack',
  blurb: 'Send messages to your own Slack channels from your app through your Slack bot.',
  category: 'messaging',
  surfaces: 'both',
  scope: 'builder',
  hosts: ['https://slack.com'],
  auth: {
    kind: 'bearer',
    secretName: 'SLACK_BOT_TOKEN',
    tokenHelp:
      'Create a Slack app with the chat:write scope, install it to your workspace, then copy the Bot User OAuth Token from the app’s OAuth and Permissions page.',
  },
  endpoints: [
    {
      id: 'send-message',
      displayName: 'Send a message',
      method: 'POST',
      path: '/api/chat.postMessage',
      class: 'send',
      params: {
        channel: {
          type: 'string',
          required: true,
          help: 'The channel the message lands in - picked in the Channel setting.',
        },
        text: {
          type: 'string',
          required: true,
          help: 'The message itself, plain text.',
        },
      },
      body: 'json',
      picks: [
        { field: 'ts', from: 'ts' },
        { field: 'channel', from: 'channel' },
        // Slack signals failure inside a 200 body: ok:false plus an error code.
        { field: 'ok', from: 'ok' },
        { field: 'error', from: 'error' },
      ],
    },
  ],
  inside: {
    // Sent log: where sends land, app-grain.
    tables: [
      {
        name: 'sent-messages',
        displayName: 'Sent messages',
        rowSchema: { channel: 'string', text: 'string', ts: 'string' },
        grain: 'app',
      },
    ],
    watchers: [],
  },
  settings: [
    {
      id: 'channel',
      label: 'Channel',
      kind: 'channel-pick',
      help: 'The channel your app sends to. The bot must be invited to it.',
    },
    {
      id: 'message',
      label: 'Message',
      kind: 'template',
      help: 'The message with field slots, or bind an input on screen.',
    },
  ],
  // Trigger rows: the event_callback envelope carries the name at event.type.
  triggers: [
    { kind: 'webhook', id: 'message-posted', displayName: 'Message posted', eventPath: 'event.type', events: ['message'] },
    { kind: 'webhook', id: 'bot-mentioned', displayName: 'Bot mentioned', eventPath: 'event.type', events: ['app_mention'] },
    { kind: 'webhook', id: 'reaction-added', displayName: 'Reaction added', eventPath: 'event.type', events: ['reaction_added'] },
    { kind: 'webhook', id: 'channel-created', displayName: 'Channel created', eventPath: 'event.type', events: ['channel_created'] },
  ],
  fixtures: [
    {
      endpoint: 'send-message',
      params: { channel: 'C123ABC456', text: "Here's a message for you" },
      status: 200,
      response: {
        ok: true,
        channel: 'C123ABC456',
        ts: '1503435956.000247',
        message: {
          text: "Here's a message for you",
          username: 'ecto1',
          bot_id: 'B123ABC456',
          type: 'message',
          subtype: 'bot_message',
          ts: '1503435956.000247',
        },
      },
    },
    {
      // Errors arrive as HTTP 200 with ok:false plus a code.
      endpoint: 'send-message',
      params: { channel: 'C0000000000', text: 'Hello' },
      status: 200,
      response: { ok: false, error: 'channel_not_found' },
    },
  ],
};
