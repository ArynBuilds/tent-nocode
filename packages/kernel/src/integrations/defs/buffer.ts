import type { IntegrationDefInput as IntegrationDef } from '../catalog.js';

// Buffer social scheduling via the GraphQL-only api.buffer.com; enum arguments stay inline in the query string.
export const buffer: IntegrationDef = {
  name: 'buffer',
  version: 1,
  displayName: 'Buffer',
  blurb: 'Schedule and publish posts to your social channels through your own Buffer account.',
  category: 'social',
  surfaces: 'both',
  scope: 'builder',
  hosts: ['https://api.buffer.com'],
  auth: {
    kind: 'bearer',
    secretName: 'BUFFER_API_KEY',
    tokenHelp: 'Create an API key under Settings, then API, in your Buffer account at publish.buffer.com.',
  },
  endpoints: [
    {
      id: 'create-post',
      displayName: 'Add a post to your queue',
      method: 'POST',
      path: '/',
      class: 'send',
      bodyConstants: {
        query:
          'mutation ($text: String!, $channel_id: ChannelId!) { createPost(input: { text: $text, channelId: $channel_id, schedulingType: automatic, mode: addToQueue }) { ... on PostActionSuccess { post { id text dueAt } } ... on MutationError { message } } }',
      },
      params: {
        text: { type: 'string', required: true, at: 'variables.text', help: 'What the post says.' },
        channel_id: { type: 'string', required: true, at: 'variables.channel_id', help: 'The Buffer channel the post goes to.' },
      },
      body: 'json',
      picks: [
        { field: 'post_id', from: 'data.createPost.post.id' },
        { field: 'due_at', from: 'data.createPost.post.dueAt' },
      ],
    },
    {
      id: 'schedule-post',
      displayName: 'Schedule a post for a time',
      method: 'POST',
      path: '/',
      class: 'send',
      bodyConstants: {
        query:
          'mutation ($text: String!, $channel_id: ChannelId!, $due_at: DateTime!) { createPost(input: { text: $text, channelId: $channel_id, schedulingType: automatic, mode: customScheduled, dueAt: $due_at }) { ... on PostActionSuccess { post { id text dueAt } } ... on MutationError { message } } }',
      },
      params: {
        text: { type: 'string', required: true, at: 'variables.text', help: 'What the post says.' },
        channel_id: { type: 'string', required: true, at: 'variables.channel_id', help: 'The Buffer channel the post goes to.' },
        due_at: { type: 'string', required: true, at: 'variables.due_at', help: 'When it publishes, ISO 8601, like 2026-03-26T10:28:47.545Z.' },
      },
      body: 'json',
      picks: [
        { field: 'post_id', from: 'data.createPost.post.id' },
        { field: 'due_at', from: 'data.createPost.post.dueAt' },
      ],
    },
    {
      id: 'list-channels',
      displayName: 'List your channels',
      method: 'POST',
      path: '/',
      class: 'read',
      bodyConstants: {
        query:
          'query ($organization_id: OrganizationId!) { channels(input: { organizationId: $organization_id }) { id name service } }',
      },
      params: {
        organization_id: { type: 'string', required: true, at: 'variables.organization_id', help: 'Your Buffer organization id.' },
      },
      body: 'json',
      picks: [
        { field: 'channel_id', from: 'data.channels.0.id' },
        { field: 'channel_name', from: 'data.channels.0.name' },
        { field: 'service', from: 'data.channels.0.service' },
      ],
    },
    {
      id: 'list-organizations',
      displayName: 'Find your organization',
      method: 'POST',
      path: '/',
      class: 'read',
      bodyConstants: {
        query: 'query { account { organizations { id } } }',
      },
      params: {},
      body: 'json',
      picks: [{ field: 'organization_id', from: 'data.account.organizations.0.id' }],
    },
  ],
  inside: {
    tables: [
      // Channel roster, one row per channel, pulled once per app.
      {
        name: 'channels',
        displayName: 'Channels',
        rowSchema: { id: 'string', name: 'string', service: 'string' },
        grain: 'app',
        fromArray: 'data.channels',
      },
      // Where sent posts land; columns fill by name from call params then picks.
      {
        name: 'sent-posts',
        displayName: 'Sent posts',
        rowSchema: { 'post-id': 'string', 'channel-id': 'string', text: 'string', 'due-at': 'string' },
        grain: 'app',
      },
    ],
    watchers: [],
  },
  settings: [
    { id: 'default_channel_id', label: 'Channel', kind: 'channel-pick', help: 'The Buffer channel your app posts to by default.' },
    { id: 'default_organization_id', label: 'Organization', kind: 'text', help: 'Your Buffer organization id, used when listing channels.' },
    { id: 'default_text', label: 'Message', kind: 'template', help: 'The post with field slots, or bind an input on screen.' },
  ],
  fixtures: [
    {
      endpoint: 'create-post',
      params: { text: 'Hello from the Buffer API!', channel_id: 'your_channel_id' },
      status: 200,
      response: { data: { createPost: { post: { id: 'your_post_id', text: 'Hello from the Buffer API!', dueAt: '2026-03-05T14:30:00.000Z' } } } },
    },
    {
      endpoint: 'schedule-post',
      params: { text: 'Hello there, this is another one!', channel_id: 'some_channel_id', due_at: '2026-03-26T10:28:47.545Z' },
      status: 200,
      response: { data: { createPost: { post: { id: 'post_123', text: 'Hello there, this is another one!', dueAt: '2026-03-26T10:28:47.545Z' } } } },
    },
    {
      endpoint: 'list-channels',
      params: { organization_id: 'your_org_id' },
      status: 200,
      response: {
        data: {
          channels: [
            { id: 'your_channel_id', name: 'My Twitter', service: 'twitter' },
            { id: 'your_other_channel_id', name: 'My Instagram', service: 'instagram' },
          ],
        },
      },
    },
    {
      endpoint: 'list-organizations',
      params: {},
      status: 200,
      response: { data: { account: { organizations: [{ id: 'your_org_id' }] } } },
    },
  ],
};
