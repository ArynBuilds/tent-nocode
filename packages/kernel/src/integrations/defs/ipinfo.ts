import type { IntegrationDefInput as IntegrationDef } from '../catalog.js';

// IPinfo IP lookup; flat top-level response fields.
export const ipinfo: IntegrationDef = {
  name: 'ipinfo',
  version: 1,
  displayName: 'IPinfo',
  blurb: 'Look up where an IP address is from and who runs it, on your own IPinfo token.',
  category: 'data',
  surfaces: 'both',
  scope: 'builder',
  hosts: ['https://ipinfo.io'],
  auth: {
    kind: 'bearer',
    secretName: 'IPINFO_TOKEN',
    tokenHelp: 'Your token from the Token page of your IPinfo dashboard.',
  },
  endpoints: [
    {
      id: 'ip-lookup',
      displayName: 'Look up an IP address',
      method: 'GET',
      path: '/{ip}',
      class: 'read',
      params: {
        ip: {
          type: 'string',
          required: true,
          help: 'The IP address to look up, like 8.8.8.8.',
        },
      },
      picks: [
        { field: 'city', from: 'city' },
        { field: 'country', from: 'country' },
        { field: 'org', from: 'org' },
      ],
    },
  ],
  inside: {
    tables: [
      {
        name: 'ip-lookups',
        displayName: 'IP lookups',
        rowSchema: { ip: 'string', city: 'string', country: 'string', org: 'string' },
        grain: 'app',
      },
    ],
    watchers: [],
  },
  settings: [],
  fixtures: [
    {
      endpoint: 'ip-lookup',
      params: { ip: '8.8.8.8' },
      status: 200,
      response: {
        ip: '8.8.8.8',
        hostname: 'dns.google',
        anycast: true,
        city: 'Mountain View',
        region: 'California',
        country: 'US',
        loc: '37.4056,-122.0775',
        org: 'AS15169 Google LLC',
        postal: '94043',
        timezone: 'America/Los_Angeles',
      },
    },
  ],
};
