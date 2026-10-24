import type { IntegrationDefInput as IntegrationDef } from '../catalog.js';

// X (Twitter) integration: publish posts to the builder's own account.
// X requires PKCE on this oauth flow; the oauth kind needs that widening before this flips ready.
export const xTwitter: IntegrationDef = {
  name: 'x',
  version: 1,
  displayName: 'X (Twitter)',
  blurb: 'Publish posts to your own X account straight from your app.',
  category: 'social',
  surfaces: 'both',
  scope: 'builder',
  // Waits on app registration at console.x.com.
  availability: 'upcoming',
  hosts: ['https://api.x.com'],
  auth: {
    kind: 'oauth',
    authUrl: 'https://x.com/i/oauth2/authorize',
    tokenUrl: 'https://api.x.com/2/oauth2/token',
    scopes: ['tweet.read', 'tweet.write', 'users.read', 'offline.access'],
    clientEnv: 'X',
    tokenHelp: 'Sign in with your X account when connecting - Nodeloom holds the keys, nothing to paste.',
  },
  endpoints: [
    {
      id: 'create-post',
      displayName: 'Publish a post',
      method: 'POST',
      path: '/2/tweets',
      class: 'send',
      params: {
        text: {
          type: 'string',
          required: true,
          help: 'The text of the post.',
        },
        in_reply_to_tweet_id: {
          type: 'string',
          at: 'reply.in_reply_to_tweet_id',
          help: 'The id of the post this one replies to.',
        },
        reply_settings: {
          type: 'string',
          choices: ['following', 'mentionedUsers', 'subscribers', 'verified'],
          help: 'Who can reply to the post. Everyone when left unset.',
        },
      },
      body: 'json',
      picks: [
        { field: 'id', from: 'data.id' },
        { field: 'text', from: 'data.text' },
      ],
    },
  ],
  inside: {
    // Published posts land here, app grain.
    tables: [
      {
        name: 'sent-posts',
        displayName: 'Sent posts',
        rowSchema: {
          text: 'string',
          id: 'string',
          'reply-settings': 'string',
        },
        grain: 'app',
      },
    ],
    watchers: [],
  },
  settings: [
    {
      id: 'default_text',
      label: 'Post text',
      kind: 'template',
      help: 'The post with field slots, or bind an input on screen.',
    },
    {
      id: 'default_reply_settings',
      label: 'Who can reply',
      kind: 'enum',
      choices: ['following', 'mentionedUsers', 'subscribers', 'verified'],
      help: 'Who can reply to posts your app publishes by default.',
    },
  ],
  fixtures: [
    {
      endpoint: 'create-post',
      params: { text: 'Hello world' },
      status: 201,
      response: {
        data: {
          id: '1234567890',
          text: 'Hello world',
          edit_history_post_ids: ['1234567890'],
        },
      },
    },
  ],
};
