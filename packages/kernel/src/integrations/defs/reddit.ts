import type { IntegrationDefInput as IntegrationDef } from '../catalog.js';

// Reddit def: post to the builder's own account and read a subreddit's hot posts.
// The hot listing nests posts under data.children[i].data, so the mirror is the top post per read via picks.
export const reddit: IntegrationDef = {
  name: 'reddit',
  version: 1,
  displayName: 'Reddit',
  blurb: 'Post to Reddit and read the hot posts of a subreddit through your own Reddit account.',
  category: 'social',
  surfaces: 'both',
  scope: 'builder',
  availability: 'upcoming',
  hosts: ['https://oauth.reddit.com'],
  // Reddit demands a unique, descriptive User-Agent; default library agents are throttled.
  headers: { 'user-agent': 'web:ai.tent-nocode.integration:v1.0' },
  auth: {
    kind: 'oauth',
    authUrl: 'https://www.reddit.com/api/v1/authorize',
    tokenUrl: 'https://www.reddit.com/api/v1/access_token',
    scopes: ['submit', 'read'],
    clientEnv: 'REDDIT',
    tokenHelp: 'Click Sign in to Reddit - Tent NoCode handles the whole sign-in; there is no key to find or paste.',
  },
  endpoints: [
    {
      id: 'submit-post',
      displayName: 'Submit a text post',
      method: 'POST',
      path: '/api/submit',
      class: 'send',
      body: 'form',
      params: {
        sr: {
          type: 'string',
          required: true,
          help: 'The subreddit to post in, without the r/ prefix.',
        },
        title: {
          type: 'string',
          required: true,
          help: 'The post title, up to 300 characters.',
        },
        text: {
          type: 'string',
          help: 'The body of the post. Markdown works.',
        },
        kind: {
          type: 'string',
          required: true,
          choices: ['self'],
          help: 'Text post. Pick the one choice.',
        },
        api_type: {
          type: 'string',
          required: true,
          choices: ['json'],
          help: 'Asks Reddit for its plain answer shape. Pick the one choice.',
        },
      },
      picks: [
        { field: 'id', from: 'json.data.id' },
        { field: 'name', from: 'json.data.name' },
        { field: 'url', from: 'json.data.url' },
      ],
    },
    {
      id: 'hot-posts',
      displayName: 'Read the hot posts',
      method: 'GET',
      path: '/r/{subreddit}/hot',
      class: 'read',
      params: {
        subreddit: {
          type: 'string',
          required: true,
          help: 'The subreddit to read, without the r/ prefix.',
        },
        limit: {
          type: 'number',
          help: 'How many posts to fetch, up to 100.',
        },
        after: {
          type: 'string',
          help: 'The fullname to page after, from a previous read.',
        },
      },
      // The top post plus the paging cursor.
      picks: [
        { field: 'title', from: 'data.children.0.data.title' },
        { field: 'author', from: 'data.children.0.data.author' },
        { field: 'score', from: 'data.children.0.data.score' },
        { field: 'permalink', from: 'data.children.0.data.permalink' },
        { field: 'after', from: 'data.after' },
      ],
    },
  ],
  inside: {
    tables: [
      {
        // Sent log: every submitted post lands here, app grain.
        name: 'sent-posts',
        displayName: 'Sent posts',
        rowSchema: {
          sr: 'string',
          title: 'string',
          id: 'string',
          name: 'string',
          url: 'string',
        },
        grain: 'app',
      },
      {
        // Hot mirror: one row per read, the subreddit's top hot post.
        name: 'hot-posts',
        displayName: 'Hot posts',
        rowSchema: {
          subreddit: 'string',
          title: 'string',
          author: 'string',
          score: 'number',
          permalink: 'string',
        },
        grain: 'app',
      },
    ],
    watchers: [],
  },
  settings: [
    {
      id: 'default_sr',
      label: 'Post to',
      kind: 'text',
      help: 'The subreddit your app posts to by default, without the r/ prefix.',
    },
    {
      id: 'default_text',
      label: 'Post body',
      kind: 'template',
      help: 'The post body with field slots, or bind an input on screen.',
    },
    {
      id: 'default_subreddit',
      label: 'Read from',
      kind: 'text',
      help: 'The subreddit whose hot posts your app reads by default.',
    },
  ],
  fixtures: [
    {
      endpoint: 'submit-post',
      params: { sr: 'test', title: 'Testing from Tent NoCode', text: 'Hello from the app.', kind: 'self', api_type: 'json' },
      status: 200,
      response: {
        json: {
          errors: [],
          data: {
            url: 'https://www.reddit.com/r/test/comments/1abcde/testing_from_tentis/',
            drafts_count: 0,
            id: '1abcde',
            name: 't3_1abcde',
          },
        },
      },
    },
    {
      // Listing shape: children of kind t3, each post nested under its child's data.
      endpoint: 'hot-posts',
      params: { subreddit: 'programming', limit: 2 },
      status: 200,
      response: {
        kind: 'Listing',
        data: {
          after: 't3_1fghij',
          before: null,
          children: [
            {
              kind: 't3',
              data: {
                id: '1abcde',
                name: 't3_1abcde',
                title: 'A post about compilers',
                author: 'example_user',
                score: 4210,
                num_comments: 312,
                permalink: '/r/programming/comments/1abcde/a_post_about_compilers/',
                url: 'https://example.com/compilers',
                subreddit: 'programming',
                created_utc: 1755216000,
                is_self: false,
              },
            },
            {
              kind: 't3',
              data: {
                id: '1fghij',
                name: 't3_1fghij',
                title: 'Why my build takes an hour',
                author: 'another_user',
                score: 987,
                num_comments: 154,
                permalink: '/r/programming/comments/1fghij/why_my_build_takes_an_hour/',
                url: 'https://www.reddit.com/r/programming/comments/1fghij/why_my_build_takes_an_hour/',
                subreddit: 'programming',
                created_utc: 1755219600,
                is_self: true,
              },
            },
          ],
        },
      },
    },
  ],
};
