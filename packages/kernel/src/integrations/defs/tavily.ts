import type { IntegrationDefInput as IntegrationDef } from '../catalog.js';

// Tavily web search integration.
export const tavily: IntegrationDef = {
  name: 'tavily',
  version: 1,
  displayName: 'Tavily',
  blurb: 'Search the web live from your app on your own Tavily key.',
  category: 'data',
  surfaces: 'both',
  scope: 'builder',
  hosts: ['https://api.tavily.com'],
  auth: {
    kind: 'bearer',
    secretName: 'TAVILY_API_KEY',
    tokenHelp: 'Create an API key in your Tavily dashboard under API Keys.',
  },
  endpoints: [
    {
      id: 'search',
      displayName: 'Search the web',
      method: 'POST',
      path: '/search',
      class: 'read',
      params: {
        query: {
          type: 'string',
          required: true,
          help: 'What to search for, in plain words.',
        },
        search_depth: {
          type: 'string',
          choices: ['basic', 'advanced'],
          help: 'How deep the search digs. Advanced costs more credits.',
        },
        topic: {
          type: 'string',
          choices: ['general', 'news'],
          help: 'General web search or recent news.',
        },
        max_results: {
          type: 'number',
          help: 'How many results to bring back, up to 20.',
        },
        include_answer: {
          type: 'boolean',
          help: 'Also return a short written answer to the query.',
        },
      },
      body: 'json',
      picks: [
        { field: 'answer', from: 'answer' },
        { field: 'top_title', from: 'results.0.title' },
        { field: 'top_url', from: 'results.0.url' },
        { field: 'top_content', from: 'results.0.content' },
      ],
    },
  ],
  inside: {
    // Each search lands one row, app grain.
    tables: [
      {
        name: 'searches',
        displayName: 'Searches',
        rowSchema: {
          query: 'string',
          answer: 'string',
          'top-title': 'string',
          'top-url': 'string',
          'top-content': 'string',
        },
        grain: 'app',
      },
    ],
    watchers: [],
  },
  settings: [
    {
      id: 'default_search_depth',
      label: 'Search depth',
      kind: 'enum',
      choices: ['basic', 'advanced'],
      help: 'The depth used when a search does not say.',
    },
    {
      id: 'default_max_results',
      label: 'Results per search',
      kind: 'number',
      help: 'How many results a search brings back by default.',
    },
    {
      id: 'default_include_answer',
      label: 'Written answer',
      kind: 'boolean',
      help: 'Whether searches also return a short written answer.',
    },
  ],
  fixtures: [
    {
      endpoint: 'search',
      params: { query: 'Who is Leo Messi?', include_answer: true },
      status: 200,
      response: {
        query: 'Who is Leo Messi?',
        answer:
          'Lionel Messi, born in 1987, is an Argentine footballer widely regarded as one of the greatest players of his generation.',
        images: [],
        results: [
          {
            title: 'Lionel Messi Facts | Britannica',
            url: 'https://www.britannica.com/facts/Lionel-Messi',
            content:
              'Lionel Messi, an Argentine footballer, is widely regarded as one of the greatest football players of his generation.',
            score: 0.81025416,
          },
        ],
        response_time: 1.67,
      },
    },
  ],
};
