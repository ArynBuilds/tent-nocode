import type { IntegrationDefInput as IntegrationDef } from '../catalog.js';

// LinkedIn post publish; 201 with no body, post URN in x-restli-id header, author URN as required setting param.
export const linkedin: IntegrationDef = {
  name: 'linkedin',
  version: 1,
  displayName: 'LinkedIn',
  blurb: 'Publish posts to your own LinkedIn feed from your app.',
  category: 'social',
  surfaces: 'both',
  scope: 'builder',
  availability: 'upcoming',
  hosts: ['https://api.linkedin.com'],
  auth: {
    kind: 'oauth',
    authUrl: 'https://www.linkedin.com/oauth/v2/authorization',
    tokenUrl: 'https://www.linkedin.com/oauth/v2/accessToken',
    scopes: ['openid', 'profile', 'w_member_social'],
    clientEnv: 'LINKEDIN',
    tokenHelp: 'Click Sign in to LinkedIn and approve the request - there is no key to paste.',
  },
  endpoints: [
    {
      id: 'create-post',
      displayName: 'Publish a post',
      method: 'POST',
      path: '/rest/posts',
      class: 'send',
      headers: {
        'linkedin-version': '202607',
        'x-restli-protocol-version': '2.0.0',
      },
      bodyConstants: {
        lifecycleState: 'PUBLISHED',
        'distribution.feedDistribution': 'MAIN_FEED',
        visibility: 'PUBLIC',
      },
      params: {
        author: {
          type: 'string',
          required: true,
          help: 'Your member URN, like urn:li:person:AbC123xyz. Fill it once in the node settings - run Look up your profile and put its sub value after urn:li:person:.',
        },
        commentary: {
          type: 'string',
          required: true,
          help: 'The text of the post.',
        },
        visibility: {
          type: 'string',
          choices: ['PUBLIC', 'CONNECTIONS'],
          help: 'Who can see the post. Public when left unset.',
        },
      },
      body: 'json',
      picks: [{ field: 'post_id', fromHeader: 'x-restli-id' }],
    },
    {
      id: 'get-profile',
      displayName: 'Look up your profile',
      method: 'GET',
      path: '/v2/userinfo',
      class: 'read',
      params: {},
      picks: [
        { field: 'sub', from: 'sub' },
        { field: 'name', from: 'name' },
      ],
    },
  ],
  inside: {
    tables: [
      {
        name: 'sent-posts',
        displayName: 'Sent posts',
        rowSchema: {
          commentary: 'string',
          visibility: 'string',
          author: 'string',
          'post-id': 'string',
        },
        grain: 'app',
      },
    ],
    watchers: [],
  },
  settings: [
    {
      id: 'author',
      label: 'Your member URN',
      kind: 'text',
      help: 'urn:li:person: followed by your member id - run Look up your profile once and use its sub value.',
    },
    {
      id: 'default_commentary',
      label: 'Post text',
      kind: 'template',
      help: 'The post with field slots, or bind an input on screen.',
    },
    {
      id: 'default_visibility',
      label: 'Visibility',
      kind: 'enum',
      choices: ['PUBLIC', 'CONNECTIONS'],
      help: 'Who can see posts your app publishes by default.',
    },
  ],
  fixtures: [
    {
      endpoint: 'create-post',
      params: {
        author: 'urn:li:person:8675309',
        commentary: 'Sample text Post',
        visibility: 'PUBLIC',
      },
      status: 201,
      response: null,
    },
    {
      endpoint: 'get-profile',
      params: {},
      status: 200,
      response: {
        sub: '782bbtaQ',
        name: 'John Doe',
        given_name: 'John',
        family_name: 'Doe',
        picture: 'https://media.licdn-ei.com/dms/image/C5F03AQHqK8v7tB1HCQ/profile-displayphoto-shrink_100_100/0/',
        locale: 'en-US',
        email: 'doe@email.com',
        email_verified: true,
      },
    },
  ],
};
