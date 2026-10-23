import type { IntegrationDefInput as IntegrationDef } from '../catalog.js';

// YouTube integration: read-only channel stats and video search on the owner's own account.
// The grammar has no constant query fields, so `part` and `mine` ride as required single-choice params.
// Nested response fields mean the mirrors use one-row picks instead of fan-out.
export const youtube: IntegrationDef = {
  name: 'youtube',
  version: 1,
  displayName: 'YouTube',
  blurb: 'Bring your own channel numbers and video search into your app through your YouTube account.',
  category: 'media',
  surfaces: 'both',
  scope: 'builder',
  availability: 'upcoming',
  hosts: ['https://www.googleapis.com'],
  auth: {
    kind: 'oauth',
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scopes: ['https://www.googleapis.com/auth/youtube.readonly'],
    clientEnv: 'GOOGLE',
    tokenHelp: 'Click Sign in to YouTube and approve read-only access to your channel - there is no key to paste.',
  },
  endpoints: [
    {
      id: 'channel-stats',
      displayName: 'See your channel numbers',
      method: 'GET',
      path: '/youtube/v3/channels',
      class: 'read',
      params: {
        stats_part: {
          type: 'string',
          required: true,
          choices: ['statistics'],
          wire: 'part',
          help: 'What the pull reads - statistics is the one choice.',
        },
        mine: {
          type: 'string',
          required: true,
          choices: ['true'],
          help: 'Reads the channel you signed in with.',
        },
      },
      picks: [
        { field: 'channel_id', from: 'items.0.id' },
        { field: 'view_count', from: 'items.0.statistics.viewCount' },
        { field: 'subscriber_count', from: 'items.0.statistics.subscriberCount' },
        { field: 'video_count', from: 'items.0.statistics.videoCount' },
      ],
    },
    {
      id: 'search-videos',
      displayName: 'Search for videos',
      method: 'GET',
      path: '/youtube/v3/search',
      class: 'read',
      params: {
        search_part: {
          type: 'string',
          required: true,
          choices: ['snippet'],
          wire: 'part',
          help: 'What each result carries - snippet is the one choice.',
        },
        query: { type: 'string', required: true, wire: 'q', help: 'What to search for.' },
        type: {
          type: 'string',
          choices: ['video', 'channel', 'playlist'],
          help: 'Videos alone, channels, or playlists.',
        },
        max_results: { type: 'number', wire: 'maxResults', help: 'How many results, up to 50.' },
        order: {
          type: 'string',
          choices: ['relevance', 'date', 'rating', 'title', 'viewCount'],
          help: 'How results sort.',
        },
      },
      picks: [
        { field: 'video_id', from: 'items.0.id.videoId' },
        { field: 'title', from: 'items.0.snippet.title' },
        { field: 'channel_title', from: 'items.0.snippet.channelTitle' },
        { field: 'published_at', from: 'items.0.snippet.publishedAt' },
        { field: 'description', from: 'items.0.snippet.description' },
      ],
    },
  ],
  inside: {
    tables: [
      {
        // One row per pull; the sync cadence writes a running history.
        name: 'channel-stats',
        displayName: 'Channel numbers',
        rowSchema: {
          'channel-id': 'string',
          'subscriber-count': 'number',
          'view-count': 'number',
          'video-count': 'number',
        },
        grain: 'app',
      },
      {
        // First-result mirror via picks; a channel pull leaves it untouched.
        name: 'videos',
        displayName: 'Videos',
        rowSchema: {
          'video-id': 'string',
          title: 'string',
          'channel-title': 'string',
          'published-at': 'string',
        },
        grain: 'app',
      },
    ],
    watchers: [],
  },
  settings: [
    // stats_part + mine feed the sync pull's required constants.
    { id: 'stats_part', label: 'Numbers to pull', kind: 'enum', choices: ['statistics'], help: 'The channel pull reads statistics - the one choice.' },
    { id: 'mine', label: 'Whose channel', kind: 'enum', choices: ['true'], help: 'The pull reads the channel you signed in with.' },
    { id: 'default_query', label: 'Search for', kind: 'text', help: 'What the app searches for when nothing else is bound.' },
  ],
  sync: { endpoint: 'channel-stats', everyMinutes: 60 },
  fixtures: [
    {
      endpoint: 'channel-stats',
      params: { stats_part: 'statistics', mine: 'true' },
      status: 200,
      response: {
        kind: 'youtube#channelListResponse',
        etag: 'etag-sample',
        pageInfo: { totalResults: 1, resultsPerPage: 5 },
        items: [
          {
            kind: 'youtube#channel',
            etag: 'etag-sample-item',
            id: 'UC_x5XG1OV2P6uZZ5FSM9Ttw',
            statistics: {
              viewCount: '148494',
              subscriberCount: '2110000',
              hiddenSubscriberCount: false,
              videoCount: '360',
            },
          },
        ],
      },
    },
    {
      endpoint: 'search-videos',
      params: { search_part: 'snippet', query: 'app building', type: 'video', max_results: 5 },
      status: 200,
      response: {
        kind: 'youtube#searchListResponse',
        etag: 'etag-sample',
        nextPageToken: 'CAUQAA',
        regionCode: 'US',
        pageInfo: { totalResults: 1000000, resultsPerPage: 5 },
        items: [
          {
            kind: 'youtube#searchResult',
            etag: 'etag-sample-item',
            id: { kind: 'youtube#video', videoId: 'dQw4w9WgXcQ' },
            snippet: {
              publishedAt: '2009-10-25T06:57:33Z',
              channelId: 'UCuAXFkgsw1L7xaCfnd5JJOw',
              title: 'Example Video',
              description: 'An example result from the docs.',
              channelTitle: 'Example Channel',
              liveBroadcastContent: 'none',
            },
          },
        ],
      },
    },
  ],
};
