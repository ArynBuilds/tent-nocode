import type { IntegrationDefInput as IntegrationDef } from '../catalog.js';

// OpenCage integration def: forward geocoding; the executor injects the key as a query param.
export const opencage: IntegrationDef = {
  name: 'opencage',
  version: 1,
  displayName: 'OpenCage',
  blurb: 'Turn addresses and place names into map coordinates on your own OpenCage key.',
  category: 'data',
  surfaces: 'both',
  scope: 'builder',
  hosts: ['https://api.opencagedata.com'],
  auth: {
    kind: 'query',
    param: 'key',
    secretName: 'OPENCAGE_API_KEY',
    tokenHelp: 'Your key from the Geocoding tab of your OpenCage account dashboard.',
  },
  endpoints: [
    {
      id: 'forward-geocode',
      displayName: 'Look up a place',
      method: 'GET',
      path: '/geocode/v1/json',
      class: 'read',
      params: {
        q: {
          type: 'string',
          required: true,
          help: 'An address or place name, like Berlin, Germany.',
        },
        countrycode: {
          type: 'string',
          help: 'Two-letter country code that narrows results, like de.',
        },
        language: {
          type: 'string',
          help: 'Language for the results, like en or de.',
        },
        limit: {
          type: 'number',
          help: 'How many matches to return, 1 to 100.',
        },
      },
      picks: [
        { field: 'lat', from: 'results.0.geometry.lat' },
        { field: 'lng', from: 'results.0.geometry.lng' },
        { field: 'formatted', from: 'results.0.formatted' },
        { field: 'confidence', from: 'results.0.confidence' },
        { field: 'country', from: 'results.0.components.country' },
      ],
    },
  ],
  inside: {
    tables: [
      {
        name: 'places',
        displayName: 'Places',
        rowSchema: {
          q: 'string',
          formatted: 'string',
          lat: 'number',
          lng: 'number',
          country: 'string',
        },
        grain: 'app',
      },
    ],
    watchers: [],
  },
  settings: [
    {
      id: 'default_countrycode',
      label: 'Country',
      kind: 'text',
      help: 'Two-letter country code applied to every lookup left unset.',
    },
    {
      id: 'default_language',
      label: 'Language',
      kind: 'text',
      help: 'Language for results when a lookup does not say.',
    },
  ],
  fixtures: [
    {
      endpoint: 'forward-geocode',
      params: { q: 'Rua Cafelândia, Carapicuíba, Brasil', limit: 1 },
      status: 200,
      response: {
        documentation: 'https://opencagedata.com/api',
        results: [
          {
            formatted:
              'Rua Cafelândia, Parque José Alexandre, Carapicuíba - SP, 06386, Brazil',
            geometry: { lat: -23.5370962, lng: -46.8359735 },
            confidence: 9,
            components: {
              country: 'Brazil',
              country_code: 'br',
              city: 'Carapicuíba',
              state: 'São Paulo',
              postcode: '06386',
              road: 'Rua Cafelândia',
            },
          },
        ],
        status: { code: 200, message: 'OK' },
        total_results: 1,
      },
    },
  ],
};
