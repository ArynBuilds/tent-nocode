import type { IntegrationDefInput as IntegrationDef } from '../catalog.js';

// NewsAPI integration def: top headlines read lane.
// `sources` is undeclared on purpose - the docs forbid mixing it with country/category.
export const newsapi: IntegrationDef = {
  name: 'newsapi',
  version: 1,
  displayName: 'NewsAPI',
  blurb: 'Bring live news headlines into your app on your own NewsAPI key.',
  category: 'data',
  surfaces: 'both',
  scope: 'builder',
  hosts: ['https://newsapi.org'],
  auth: {
    kind: 'header',
    header: 'x-api-key',
    secretName: 'NEWSAPI_API_KEY',
    tokenHelp: 'Your API key from your account page at newsapi.org.',
  },
  endpoints: [
    {
      id: 'top-headlines',
      displayName: 'Look up the top headlines',
      method: 'GET',
      path: '/v2/top-headlines',
      class: 'read',
      params: {
        country: {
          type: 'string',
          help: 'Two-letter country code, like us or de.',
        },
        category: {
          type: 'string',
          choices: [
            'business',
            'entertainment',
            'general',
            'health',
            'science',
            'sports',
            'technology',
          ],
        },
        q: {
          type: 'string',
          help: 'Keywords to search headlines for.',
        },
      },
      picks: [
        { field: 'title', from: 'articles.0.title' },
        { field: 'source_name', from: 'articles.0.source.name' },
        { field: 'author', from: 'articles.0.author' },
        { field: 'description', from: 'articles.0.description' },
        { field: 'url', from: 'articles.0.url' },
        { field: 'published_at', from: 'articles.0.publishedAt' },
        { field: 'total_results', from: 'totalResults' },
      ],
    },
  ],
  inside: {
    tables: [
      {
        name: 'headlines',
        displayName: 'Headlines',
        rowSchema: {
          title: 'string',
          'source-name': 'string',
          author: 'string',
          description: 'string',
          url: 'string',
          'published-at': 'string',
          country: 'string',
          category: 'string',
          'total-results': 'number',
        },
        grain: 'app',
      },
    ],
    watchers: [],
  },
  settings: [
    {
      id: 'default_country',
      label: 'Country',
      kind: 'text',
      help: 'Two-letter country code your app pulls headlines for.',
    },
    {
      id: 'default_category',
      label: 'Category',
      kind: 'enum',
      choices: [
        'business',
        'entertainment',
        'general',
        'health',
        'science',
        'sports',
        'technology',
      ],
    },
  ],
  fixtures: [
    {
      endpoint: 'top-headlines',
      params: { country: 'us', category: 'technology' },
      status: 200,
      response: {
        status: 'ok',
        totalResults: 36,
        articles: [
          {
            source: { id: 'the-verge', name: 'The Verge' },
            author: 'Jess Weatherbed',
            title: 'A new chip promises faster laptops',
            description: 'The next generation of laptop processors arrives this fall.',
            url: 'https://www.theverge.com/2026/8/14/laptop-chip',
            urlToImage: 'https://cdn.vox-cdn.com/thumbor/example.jpg',
            publishedAt: '2026-08-14T12:34:56Z',
            content: 'The next generation of laptop processors arrives this fall… [+1200 chars]',
          },
        ],
      },
    },
  ],
};
