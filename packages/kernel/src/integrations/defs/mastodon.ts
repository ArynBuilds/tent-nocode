import type { IntegrationDefInput as IntegrationDef } from '../catalog.js';

// Mastodon integration def: post to the builder's own account on an owner-pinned instance.
export const mastodon: IntegrationDef = {
  name: 'mastodon',
  version: 1,
  displayName: 'Mastodon',
  blurb: 'Post to your own Mastodon account from your app, on whichever instance you call home.',
  category: 'social',
  surfaces: 'both',
  scope: 'builder',
  // Owner pastes their instance origin at Connect.
  hosts: { ownerPinned: true },
  auth: {
    kind: 'bearer',
    secretName: 'MASTODON_ACCESS_TOKEN',
    tokenHelp: 'On your instance, open Preferences, then Development, create a new application, and copy its access token.',
  },
  endpoints: [
    {
      id: 'send-post',
      displayName: 'Publish a post',
      method: 'POST',
      path: '/api/v1/statuses',
      class: 'send',
      params: {
        status: {
          type: 'string',
          required: true,
          help: 'The text of the post.',
        },
        visibility: {
          type: 'string',
          choices: ['public', 'unlisted', 'private', 'direct'],
          help: 'Who can see the post. Public when left unset.',
        },
        spoiler_text: {
          type: 'string',
          help: 'A content warning shown before the post text.',
        },
        in_reply_to_id: {
          type: 'string',
          help: 'The id of the post this one replies to.',
        },
        language: {
          type: 'string',
          help: 'Two-letter language code, like en.',
        },
        sensitive: {
          type: 'boolean',
          help: 'Mark attached media as sensitive.',
        },
      },
      body: 'form',
      picks: [
        { field: 'id', from: 'id' },
        { field: 'url', from: 'url' },
        { field: 'created_at', from: 'created_at' },
      ],
    },
  ],
  inside: {
    // Every published post lands here.
    tables: [
      {
        name: 'sent-posts',
        displayName: 'Sent posts',
        rowSchema: {
          status: 'string',
          visibility: 'string',
          id: 'string',
          url: 'string',
          'created-at': 'string',
        },
        grain: 'app',
      },
    ],
    watchers: [],
  },
  settings: [
    {
      id: 'default_status',
      label: 'Post text',
      kind: 'template',
      help: 'The post with field slots, or bind an input on screen.',
    },
    {
      id: 'default_visibility',
      label: 'Visibility',
      kind: 'enum',
      choices: ['public', 'unlisted', 'private', 'direct'],
      help: 'Who can see posts your app publishes by default.',
    },
  ],
  fixtures: [
    {
      endpoint: 'send-post',
      params: { status: 'test content', visibility: 'public' },
      status: 200,
      response: {
        id: '103254962155278888',
        created_at: '2019-12-05T11:34:47.196Z',
        content: '<p>test content</p>',
        visibility: 'public',
        url: 'https://mastodon.social/@username/103254962155278888',
        application: { name: 'test app', website: null },
        media_attachments: [],
        poll: null,
      },
    },
  ],
};
