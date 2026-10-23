import type { IntegrationDefInput as IntegrationDef } from '../catalog.js';

// WeatherAPI.com weather feed; the key rides the query string, injected by the executor.
export const weatherapi: IntegrationDef = {
  name: 'weatherapi',
  version: 1,
  displayName: 'WeatherAPI',
  blurb: 'Bring live weather into your app on your own WeatherAPI.com key.',
  category: 'data',
  surfaces: 'both',
  scope: 'builder',
  hosts: ['https://api.weatherapi.com'],
  auth: {
    kind: 'query',
    param: 'key',
    secretName: 'WEATHERAPI_API_KEY',
    tokenHelp: 'Your key from the WeatherAPI.com dashboard, shown on the My Account page after you sign up.',
  },
  endpoints: [
    {
      id: 'current-weather',
      displayName: 'Look up the weather',
      method: 'GET',
      path: '/v1/current.json',
      class: 'read',
      params: {
        q: {
          type: 'string',
          required: true,
          help: 'Where to look: a city name like Istanbul, a postcode, or "lat,lon" coordinates.',
        },
        aqi: {
          type: 'string',
          choices: ['yes', 'no'],
          help: 'Include air quality data in the answer.',
        },
      },
      picks: [
        { field: 'city', from: 'location.name' },
        { field: 'country', from: 'location.country' },
        { field: 'temp_c', from: 'current.temp_c' },
        { field: 'condition', from: 'current.condition.text' },
        { field: 'humidity', from: 'current.humidity' },
        { field: 'wind_kph', from: 'current.wind_kph' },
        { field: 'feelslike_c', from: 'current.feelslike_c' },
      ],
    },
  ],
  inside: {
    // Weather pulls once per app; kebab columns match their snake pick twins.
    tables: [
      {
        name: 'weather',
        displayName: 'Weather',
        rowSchema: {
          city: 'string',
          country: 'string',
          'temp-c': 'number',
          condition: 'string',
          humidity: 'number',
          'wind-kph': 'number',
          'feelslike-c': 'number',
        },
        grain: 'app',
      },
    ],
    watchers: [],
  },
  settings: [
    {
      id: 'default_q',
      label: 'Location',
      kind: 'text',
      help: 'The place your app shows weather for when nothing else picks one.',
    },
  ],
  fixtures: [
    {
      endpoint: 'current-weather',
      params: { q: 'London' },
      status: 200,
      response: {
        location: {
          name: 'London',
          region: 'City of London, Greater London',
          country: 'United Kingdom',
          lat: 51.52,
          lon: -0.11,
          tz_id: 'Europe/London',
          localtime_epoch: 1673620218,
          localtime: '2023-01-13 14:30',
        },
        current: {
          last_updated_epoch: 1673620200,
          last_updated: '2023-01-13 14:30',
          temp_c: 11.0,
          temp_f: 51.8,
          is_day: 1,
          condition: {
            text: 'Partly cloudy',
            icon: '//cdn.weatherapi.com/weather/64x64/day/116.png',
            code: 1003,
          },
          wind_mph: 23.0,
          wind_kph: 37.1,
          wind_degree: 270,
          wind_dir: 'W',
          pressure_mb: 1010.0,
          precip_mm: 0.0,
          humidity: 58,
          cloud: 75,
          feelslike_c: 8.1,
          feelslike_f: 46.5,
          vis_km: 10.0,
          uv: 2.0,
        },
      },
    },
  ],
};
