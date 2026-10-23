// ExchangeRate-API live currency rates on the keyless open endpoint; the free lane asks for a visible attribution link in the consuming app.
import type { IntegrationDefInput as IntegrationDef } from '../catalog.js';

export const exchangerate: IntegrationDef = {
  name: 'exchangerate',
  version: 1,
  displayName: 'ExchangeRate-API',
  blurb: 'Bring live currency exchange rates into your app, no key needed.',
  category: 'data',
  surfaces: 'both',
  scope: 'builder',
  hosts: ['https://open.er-api.com'],
  auth: { kind: 'none' },
  endpoints: [
    {
      id: 'latest-rates',
      displayName: 'Look up the latest exchange rates',
      method: 'GET',
      path: '/v6/latest/{base}',
      class: 'read',
      params: {
        base: { type: 'string', required: true, help: 'The three-letter currency code the rates are quoted against, like USD or EUR.' },
      },
      picks: [
        { field: 'base', from: 'base_code' },
        { field: 'updated', from: 'time_last_update_utc' },
        { field: 'usd', from: 'rates.USD' },
        { field: 'eur', from: 'rates.EUR' },
        { field: 'gbp', from: 'rates.GBP' },
      ],
    },
  ],
  inside: {
    // Rates pull once per app.
    tables: [
      {
        name: 'exchange-rates',
        displayName: 'Exchange rates',
        rowSchema: { code: 'string', rate: 'number' },
        grain: 'app',
      },
    ],
    watchers: [],
  },
  settings: [
    { id: 'base_currency', label: 'Base currency', kind: 'text', help: 'The three-letter code your rates are quoted against, like USD.' },
  ],
  fixtures: [
    {
      endpoint: 'latest-rates',
      params: { base: 'USD' },
      status: 200,
      response: {
        result: 'success',
        provider: 'https://www.exchangerate-api.com',
        documentation: 'https://www.exchangerate-api.com/docs/free',
        terms_of_use: 'https://www.exchangerate-api.com/terms',
        time_last_update_unix: 1585872397,
        time_last_update_utc: 'Fri, 02 Apr 2020 00:06:37 +0000',
        time_next_update_unix: 1585959987,
        time_next_update_utc: 'Sat, 03 Apr 2020 00:26:27 +0000',
        time_eol_unix: 0,
        base_code: 'USD',
        rates: {
          USD: 1,
          AED: 3.67,
          ARS: 64.51,
          AUD: 1.65,
          CAD: 1.42,
          CHF: 0.97,
          CLP: 864.53,
          CNY: 7.1,
          EUR: 0.919,
          GBP: 0.806,
          HKD: 7.75,
        },
      },
    },
  ],
};
