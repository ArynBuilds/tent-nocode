import type { IntegrationDefInput as IntegrationDef } from '../catalog.js';

// Facebook Pages integration def: publish posts to the builder's own Page.
// Upcoming: needs Meta App Review, a derived Page-token step, and a long-lived-exchange refresh form our oauth custody lacks.
export const metaPages: IntegrationDef = {
  name: 'meta-pages',
  version: 1,
  displayName: 'Facebook Pages',
  blurb: 'Publish posts to your own Facebook Page straight from your app.',
  category: 'social',
  surfaces: 'both',
  scope: 'builder',
  availability: 'upcoming',
  hosts: ['https://graph.facebook.com'],
  auth: {
    kind: 'oauth',
    authUrl: 'https://www.facebook.com/v25.0/dialog/oauth',
    tokenUrl: 'https://graph.facebook.com/v25.0/oauth/access_token',
    // pages_read_engagement is docs-required alongside manage_posts for the /feed edge.
    scopes: ['pages_show_list', 'pages_manage_posts', 'pages_read_engagement'],
    clientEnv: 'META',
    tokenHelp: 'Sign in with Facebook and allow access to the Page your app posts to.',
  },
  endpoints: [
    {
      id: 'create-post',
      displayName: 'Publish a Page post',
      method: 'POST',
      path: '/v25.0/{page_id}/feed',
      class: 'send',
      params: {
        page_id: {
          type: 'string',
          required: true,
          help: 'The id of the Facebook Page to post to.',
        },
        message: {
          type: 'string',
          required: true,
          help: 'The text of the post.',
        },
        link: {
          type: 'string',
          help: 'A web address to attach to the post.',
        },
      },
      body: 'form',
      picks: [{ field: 'id', from: 'id' }],
    },
  ],
  inside: {
    tables: [
      {
        name: 'sent-posts',
        displayName: 'Posted to Facebook',
        rowSchema: {
          message: 'string',
          link: 'string',
          'page-id': 'string',
          id: 'string',
        },
        grain: 'app',
      },
    ],
    watchers: [],
  },
  settings: [
    {
      id: 'page_id',
      label: 'Page',
      kind: 'text',
      help: 'The id of the Facebook Page your app posts to.',
    },
    {
      id: 'default_message',
      label: 'Post text',
      kind: 'template',
      help: 'The post with field slots, or bind an input on screen.',
    },
  ],
  fixtures: [
    {
      endpoint: 'create-post',
      params: {
        page_id: '1234567890',
        message: 'Hello from my app',
      },
      status: 200,
      response: { id: '1234567890_9876543210' },
    },
  ],
};
