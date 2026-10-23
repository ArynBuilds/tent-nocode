import type { IntegrationDefInput as IntegrationDef } from '../catalog.js';

// Pinterest integration def: publish pins and list boards.
// Upcoming - waits on Tent NoCode app registration; the token call also requires basic auth the oauth exchange does not carry yet.
export const pinterest: IntegrationDef = {
  name: 'pinterest',
  version: 1,
  displayName: 'Pinterest',
  blurb: 'Publish pins to your own Pinterest boards straight from your app.',
  category: 'social',
  surfaces: 'both',
  scope: 'builder',
  availability: 'upcoming',
  hosts: ['https://api.pinterest.com'],
  auth: {
    kind: 'oauth',
    authUrl: 'https://www.pinterest.com/oauth/',
    tokenUrl: 'https://api.pinterest.com/v5/oauth/token',
    scopes: ['boards:read', 'boards:write', 'pins:read', 'pins:write'],
    clientEnv: 'PINTEREST',
    tokenHelp: 'Sign in with your Pinterest account when connecting - Tent NoCode holds the keys, nothing to paste.',
  },
  endpoints: [
    {
      id: 'create-pin',
      displayName: 'Create a pin',
      method: 'POST',
      path: '/v5/pins',
      class: 'send',
      params: {
        board_id: {
          type: 'string',
          required: true,
          help: 'The id of the board the pin lands on.',
        },
        image_url: {
          type: 'string',
          required: true,
          at: 'media_source.url',
          help: 'A direct link to the image the pin shows.',
        },
        title: {
          type: 'string',
          help: 'The pin title, up to 100 characters.',
        },
        description: {
          type: 'string',
          help: 'The pin description, up to 800 characters.',
        },
        link: {
          type: 'string',
          help: 'Where the pin points when clicked.',
        },
        alt_text: {
          type: 'string',
          help: 'Alt text describing the image.',
        },
      },
      body: 'json',
      // Fixed discriminator for the image_url media variant.
      bodyConstants: { 'media_source.source_type': 'image_url' },
      picks: [
        { field: 'id', from: 'id' },
        { field: 'created_at', from: 'created_at' },
      ],
    },
    {
      id: 'list-boards',
      displayName: 'List your boards',
      method: 'GET',
      path: '/v5/boards',
      class: 'read',
      params: {
        page_size: {
          type: 'number',
          help: 'How many boards per page, 1 to 250. 25 when left unset.',
        },
        privacy: {
          type: 'string',
          choices: ['ALL', 'PUBLIC', 'PROTECTED', 'SECRET', 'PUBLIC_AND_SECRET'],
          help: 'Which boards to include. All of them when left unset.',
        },
        bookmark: {
          type: 'string',
          help: 'The cursor from the previous page, for the next one.',
        },
      },
      picks: [{ field: 'bookmark', from: 'bookmark' }],
    },
  ],
  inside: {
    tables: [
      // Every published pin lands here.
      {
        name: 'posted-pins',
        displayName: 'Posted pins',
        rowSchema: {
          title: 'string',
          'board-id': 'string',
          'image-url': 'string',
          id: 'string',
          'created-at': 'string',
        },
        grain: 'app',
      },
      // One row per board in the response's items array; nested objects drop.
      {
        name: 'boards',
        displayName: 'Boards',
        rowSchema: {
          id: 'string',
          name: 'string',
          description: 'string',
          privacy: 'string',
          'pin-count': 'number',
          'follower-count': 'number',
        },
        grain: 'app',
        fromArray: 'items',
      },
    ],
    watchers: [],
  },
  settings: [
    {
      id: 'board_id',
      label: 'Board',
      kind: 'text',
      help: 'The id of the board pins land on by default.',
    },
    {
      id: 'default_title',
      label: 'Pin title',
      kind: 'template',
      help: 'The title with field slots, or bind an input on screen.',
    },
  ],
  fixtures: [
    {
      endpoint: 'create-pin',
      params: {
        board_id: '1022106146619699845',
        image_url: 'https://www.example.com/images/summer-recipe.jpg',
        title: 'Summer recipe',
      },
      status: 201,
      response: {
        id: '813744226420795884',
        created_at: '2026-08-15T09:00:00',
        board_id: '1022106146619699845',
        board_section_id: null,
        title: 'Summer recipe',
        description: null,
        link: null,
        alt_text: null,
        media: { media_type: 'image' },
      },
    },
    {
      endpoint: 'list-boards',
      params: { page_size: 25 },
      status: 200,
      response: {
        items: [
          {
            id: '549755885175',
            name: 'Summer Recipes',
            description: 'My favorite summer recipes',
            privacy: 'PUBLIC',
            pin_count: 5,
            follower_count: 13,
            created_at: '2020-01-01T20:10:40',
            collaborator_count: 0,
          },
        ],
        bookmark: null,
      },
    },
  ],
};
