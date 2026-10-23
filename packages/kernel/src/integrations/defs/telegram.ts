import type { IntegrationDefInput as IntegrationDef } from '../catalog.js';

// Telegram Bot API integration; the bot token rides as a path prefix, never a param.
export const telegram: IntegrationDef = {
  name: 'telegram',
  version: 1,
  displayName: 'Telegram',
  blurb: 'Send Telegram messages from your app through your own bot.',
  category: 'messaging',
  surfaces: 'both',
  scope: 'builder',
  hosts: ['https://api.telegram.org'],
  auth: {
    kind: 'path',
    template: '/bot{secret}',
    secretName: 'TELEGRAM_BOT_TOKEN',
    tokenHelp: 'Message @BotFather on Telegram and create a bot - it replies with the token.',
  },
  endpoints: [{
    id: 'send-message',
    displayName: 'Send a message',
    method: 'POST',
    path: '/sendMessage',
    class: 'send',
    params: {
      chat_id: {
        type: 'string',
        required: true,
        help: 'The chat to send to - a numeric chat id or an @channelusername.',
      },
      text: {
        type: 'string',
        required: true,
        help: 'The message text, up to 4096 characters.',
      },
    },
    body: 'json',
    picks: [{ field: 'message_id', from: 'result.message_id' }],
  }],
  inside: {
    // Sent messages land here, app grain; columns are kebab-case.
    tables: [{
      name: 'sent-messages',
      displayName: 'Sent messages',
      rowSchema: { 'chat-id': 'string', text: 'string', 'message-id': 'number' },
      grain: 'app',
    }],
    watchers: [],
  },
  settings: [
    {
      id: 'chat_id',
      label: 'Chat',
      kind: 'text',
      help: 'The chat your app sends to by default - a numeric chat id or an @channelusername.',
    },
    {
      id: 'message_template',
      label: 'Message',
      kind: 'template',
      help: 'The message with field slots, or bind an input on screen.',
    },
  ],
  // Telegram updates carry no event-name field; chat.type presence discriminates the update kind.
  triggers: [
    { kind: 'webhook', id: 'message-received', displayName: 'Message received', eventPath: 'message.chat.type', events: ['private', 'group', 'supergroup', 'channel'] },
    { kind: 'webhook', id: 'message-edited', displayName: 'Message edited', eventPath: 'edited_message.chat.type', events: ['private', 'group', 'supergroup', 'channel'] },
    { kind: 'webhook', id: 'channel-post-published', displayName: 'Channel post published', eventPath: 'channel_post.chat.type', events: ['channel'] },
  ],
  fixtures: [{
    endpoint: 'send-message',
    params: { chat_id: '123456789', text: 'Hello from your app' },
    status: 200,
    response: {
      ok: true,
      result: {
        message_id: 12345,
        date: 1234567890,
        chat: { id: 123456789, type: 'private' },
        text: 'Hello from your app',
      },
    },
  }],
};
