import type { IntegrationDefInput as IntegrationDef } from '../catalog.js';

// CoinGecko crypto prices; reads ride /coins/markets because /simple/price keys by coin id, which static picks cannot address.
export const coingecko: IntegrationDef = {
  name: 'coingecko',
  version: 1,
  displayName: 'CoinGecko',
  blurb: 'Bring live crypto prices into your app on your own free CoinGecko key.',
  category: 'data',
  surfaces: 'both',
  scope: 'builder',
  hosts: ['https://api.coingecko.com'],
  auth: {
    kind: 'header',
    header: 'x-cg-demo-api-key',
    secretName: 'COINGECKO_API_KEY',
    tokenHelp: 'Create a free Demo API key under Developer Dashboard on coingecko.com.',
  },
  endpoints: [
    {
      id: 'coin-price',
      displayName: 'Look up a coin price',
      method: 'GET',
      path: '/api/v3/coins/markets',
      class: 'read',
      params: {
        vs_currency: {
          type: 'string',
          required: true,
          help: 'The currency prices are shown in, like usd or eur.',
        },
        ids: {
          type: 'string',
          required: true,
          help: 'The coin to look up, by its CoinGecko id, like bitcoin. The first coin named lands in the table.',
        },
      },
      picks: [
        { field: 'coin', from: '0.name' },
        { field: 'symbol', from: '0.symbol' },
        { field: 'price', from: '0.current_price' },
        { field: 'change_24h', from: '0.price_change_percentage_24h' },
        { field: 'updated', from: '0.last_updated' },
      ],
    },
  ],
  inside: {
    // Prices pull once per app.
    tables: [
      {
        name: 'coin-prices',
        displayName: 'Coin prices',
        rowSchema: {
          coin: 'string',
          symbol: 'string',
          price: 'number',
          'change-24h': 'number',
          'vs-currency': 'string',
          updated: 'string',
        },
        grain: 'app',
      },
    ],
    watchers: [],
  },
  settings: [
    {
      id: 'default_vs_currency',
      label: 'Currency',
      kind: 'text',
      help: 'The currency prices are shown in when a call leaves it unset.',
    },
    {
      id: 'default_ids',
      label: 'Coin',
      kind: 'text',
      help: 'The coin your app reads by default, by its CoinGecko id, like bitcoin.',
    },
  ],
  fixtures: [
    {
      endpoint: 'coin-price',
      params: { vs_currency: 'usd', ids: 'bitcoin' },
      status: 200,
      response: [
        {
          id: 'bitcoin',
          symbol: 'btc',
          name: 'Bitcoin',
          current_price: 77671,
          market_cap: 1555886872303,
          market_cap_rank: 1,
          high_24h: 78419,
          low_24h: 76696,
          price_change_24h: -747.34,
          price_change_percentage_24h: -0.95302,
          last_updated: '2026-05-18T12:49:21.599Z',
        },
      ],
    },
  ],
};
