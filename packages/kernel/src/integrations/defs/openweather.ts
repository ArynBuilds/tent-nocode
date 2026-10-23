import type { IntegrationDefInput as IntegrationDef } from '../catalog.js';

export const openweather: IntegrationDef = {
  name: 'openweather',
  version: 1,
  displayName: 'OpenWeather',
  blurb: 'Bring live weather into your app on your own OpenWeather key.',
  category: 'data',
  surfaces: 'both',
  scope: 'builder',
  hosts: ['https://api.openweathermap.org'],
  auth: {
    kind: 'query',
    param: 'appid',
    secretName: 'OPENWEATHER_API_KEY',
    tokenHelp: 'Your key from the API keys page of your OpenWeather account.',
  },
  endpoints: [
    {
      id: 'current-weather',
      displayName: 'Look up the weather',
      method: 'GET',
      path: '/data/2.5/weather',
      class: 'read',
      params: {
        q: { type: 'string', required: true, help: 'City name, like Istanbul. You can add a country code, like Istanbul,TR.' },
        units: { type: 'string', choices: ['standard', 'metric', 'imperial'], help: 'How temperature reads: standard is Kelvin, metric is Celsius, imperial is Fahrenheit.' },
      },
      picks: [
        { field: 'temp', from: 'main.temp' },
        { field: 'description', from: 'weather.0.description' },
        { field: 'city', from: 'name' },
      ],
    },
  ],
  inside: {
    tables: [
      {
        name: 'weather',
        displayName: 'Weather',
        rowSchema: { city: 'string', temp: 'number', description: 'string' },
        grain: 'app',
      },
    ],
    watchers: [],
  },
  settings: [
    { id: 'default_city', label: 'City', kind: 'text', help: 'The city your app shows weather for by default.' },
  ],
  fixtures: [
    {
      endpoint: 'current-weather',
      params: { q: 'Zocca', units: 'metric' },
      status: 200,
      response: {
        name: 'Zocca',
        main: { temp: 298.48 },
        weather: [{ description: 'moderate rain' }],
      },
    },
  ],
};
