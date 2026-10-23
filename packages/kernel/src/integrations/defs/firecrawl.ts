import type { IntegrationDefInput as IntegrationDef } from '../catalog.js';

// Firecrawl page scrape; everything it returns is untrusted page content and lands as data only.
export const firecrawl: IntegrationDef = {
  name: 'firecrawl',
  version: 1,
  displayName: 'Firecrawl',
  blurb: 'Read any web page as clean text inside your app, on your own Firecrawl key.',
  category: 'data',
  surfaces: 'both',
  scope: 'builder',
  hosts: ['https://api.firecrawl.dev'],
  auth: {
    kind: 'bearer',
    secretName: 'FIRECRAWL_API_KEY',
    tokenHelp: 'Create an API key under API Keys in your Firecrawl dashboard.',
  },
  endpoints: [
    {
      id: 'scrape-page',
      displayName: 'Read a web page',
      method: 'POST',
      path: '/v1/scrape',
      class: 'read',
      params: {
        url: {
          type: 'string',
          required: true,
          help: 'The address of the page to read, like https://example.com.',
        },
        only_main_content: {
          type: 'boolean',
          wire: 'onlyMainContent',
          help: 'Keep just the main article and skip menus, headers, and footers.',
        },
      },
      body: 'json',
      bodyConstants: { 'formats.0': 'markdown' },
      picks: [
        { field: 'markdown', from: 'data.markdown' },
        { field: 'title', from: 'data.metadata.title' },
        { field: 'source_url', from: 'data.metadata.sourceURL' },
        { field: 'status_code', from: 'data.metadata.statusCode' },
      ],
    },
  ],
  inside: {
    // Pages pull once per app.
    tables: [
      {
        name: 'scraped-pages',
        displayName: 'Scraped pages',
        rowSchema: {
          url: 'string',
          title: 'string',
          markdown: 'string',
          'source-url': 'string',
          'status-code': 'number',
        },
        grain: 'app',
      },
    ],
    watchers: [],
  },
  settings: [
    {
      id: 'default_url',
      label: 'Page address',
      kind: 'text',
      help: 'The page your app reads when no address is given.',
    },
  ],
  fixtures: [
    {
      endpoint: 'scrape-page',
      params: { url: 'https://example.com', only_main_content: true },
      status: 200,
      response: {
        success: true,
        data: {
          markdown:
            '# Example Domain\\n\\nThis domain is for use in illustrative examples in documents. You may use this domain in literature without prior coordination or asking for permission.',
          metadata: {
            title: 'Example Domain',
            sourceURL: 'https://example.com',
            statusCode: 200,
          },
        },
      },
    },
  ],
};
