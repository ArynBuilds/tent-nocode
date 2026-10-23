import type { IntegrationDefInput as IntegrationDef } from '../catalog.js';

// Mapbox integration def: forward geocoding only; token injected as a query param by the executor.
export const mapbox: IntegrationDef = {
  name: 'mapbox',
  version: 1,
  displayName: 'Mapbox',
  blurb: 'Turn place names and addresses into map coordinates with your own Mapbox account.',
  category: 'data',
  surfaces: 'both',
  scope: 'builder',
  hosts: ['https://api.mapbox.com'],
  auth: {
    kind: 'query',
    param: 'access_token',
    secretName: 'MAPBOX_ACCESS_TOKEN',
    tokenHelp: 'Your access token from the Tokens page of your Mapbox account at account.mapbox.com.',
  },
  endpoints: [
    {
      id: 'forward-geocode',
      displayName: 'Find a place',
      method: 'GET',
      path: '/search/geocode/v6/forward',
      class: 'read',
      params: {
        q: {
          type: 'string',
          required: true,
          help: 'The place to look up - a name or address, like Eiffel Tower or 1600 Pennsylvania Ave.',
        },
        limit: {
          type: 'number',
          help: 'How many matches to return, up to 10.',
        },
        language: {
          type: 'string',
          help: 'Language for the results, like en or tr.',
        },
        country: {
          type: 'string',
          help: 'Limit matches to countries - two-letter codes, comma separated, like tr or us,ca.',
        },
      },
      picks: [
        { field: 'longitude', from: 'features.0.geometry.coordinates.0' },
        { field: 'latitude', from: 'features.0.geometry.coordinates.1' },
        { field: 'name', from: 'features.0.properties.name' },
        { field: 'full_address', from: 'features.0.properties.full_address' },
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
          name: 'string',
          'full-address': 'string',
          longitude: 'number',
          latitude: 'number',
        },
        grain: 'app',
      },
    ],
    watchers: [],
  },
  settings: [
    { id: 'default_country', label: 'Country', kind: 'text', help: 'Keep results inside these countries by default - two-letter codes like tr.' },
    { id: 'default_language', label: 'Language', kind: 'text', help: 'The language results come back in by default, like en.' },
  ],
  fixtures: [
    {
      endpoint: 'forward-geocode',
      params: { q: 'Los Angeles', limit: 1 },
      status: 200,
      response: {
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            id: 'dXJuOm1ieHBsYzpFU2Jn',
            geometry: { type: 'Point', coordinates: [-118.242766, 34.053691] },
            properties: {
              mapbox_id: 'dXJuOm1ieHBsYzpFU2Jn',
              feature_type: 'place',
              name: 'Los Angeles',
              name_preferred: 'Los Angeles',
              full_address: 'Los Angeles, California, United States',
              place_formatted: 'California, United States',
              coordinates: { longitude: -118.242766, latitude: 34.053691 },
              match_code: { confidence: 'exact' },
            },
          },
        ],
        attribution: 'NOTICE: (c) 2026 Mapbox and its suppliers. All rights reserved.',
      },
    },
  ],
};
