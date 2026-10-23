import type { IntegrationDefInput as IntegrationDef } from '../catalog.js';

// Serper - Google search results as JSON; everything returned is untrusted data.
export const serper: IntegrationDef = {
  name: 'serper',
  version: 1,
  displayName: 'Serper',
  blurb: 'Bring live Google search results into your app on your own Serper key.',
  category: 'data',
  surfaces: 'both',
  scope: 'builder',
  hosts: ['https://google.serper.dev'],
  auth: {
    kind: 'header',
    header: 'x-api-key',
    secretName: 'SERPER_API_KEY',
    tokenHelp: 'Your API key from the Serper dashboard at serper.dev.',
  },
  endpoints: [
    {
      id: 'search',
      displayName: 'Search Google',
      method: 'POST',
      path: '/search',
      class: 'read',
      params: {
        query: {
          type: 'string',
          required: true,
          wire: 'q',
          help: 'What to search Google for.',
        },
        country: {
          type: 'string',
          wire: 'gl',
          help: 'Two-letter country code the results come from, like us or tr.',
        },
        language: {
          type: 'string',
          wire: 'hl',
          help: 'Two-letter language code for the results, like en or tr.',
        },
        results: {
          type: 'number',
          wire: 'num',
          help: 'How many results to ask Google for.',
        },
        page: {
          type: 'number',
          help: 'Which page of results, starting at 1.',
        },
      },
      body: 'json',
      picks: [
        { field: 'title', from: 'organic.0.title' },
        { field: 'link', from: 'organic.0.link' },
        { field: 'snippet', from: 'organic.0.snippet' },
        { field: 'position', from: 'organic.0.position' },
      ],
    },
  ],
  inside: {
    // Searches land once per app; every user reads them.
    tables: [
      {
        name: 'search-results',
        displayName: 'Search results',
        rowSchema: {
          query: 'string',
          title: 'string',
          link: 'string',
          snippet: 'string',
          position: 'number',
        },
        grain: 'app',
      },
    ],
    watchers: [],
  },
  settings: [
    { id: 'default_query', label: 'Search for', kind: 'text', help: 'The search your app runs when nothing on screen supplies one.' },
    { id: 'default_country', label: 'Country', kind: 'text', help: 'Two-letter country code the results come from, like us or tr.' },
  ],
  fixtures: [
    {
      endpoint: 'search',
      params: { query: 'apple inc' },
      status: 200,
      response: {
        searchParameters: { q: 'apple inc', type: 'search', engine: 'google' },
        organic: [
          {
            title: 'Apple',
            link: 'https://www.apple.com/',
            snippet: 'Discover the innovative world of Apple and shop everything iPhone, iPad, Apple Watch, Mac, and Apple TV.',
            position: 1,
          },
          {
            title: 'Apple Inc. - Wikipedia',
            link: 'https://en.wikipedia.org/wiki/Apple_Inc.',
            snippet: 'Apple Inc. is an American multinational technology company headquartered in Cupertino, California.',
            position: 2,
          },
        ],
      },
    },
  ],
};
