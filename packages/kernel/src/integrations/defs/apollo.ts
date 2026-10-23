import type { IntegrationDefInput as IntegrationDef } from '../catalog.js';

export const apollo: IntegrationDef = {
  name: 'apollo', version: 1,
  displayName: 'Apollo',
  blurb: 'Look up person and company details from your own Apollo account.',
  category: 'data', surfaces: 'both', scope: 'builder',
  hosts: ['https://api.apollo.io'],
  auth: {
    kind: 'header', header: 'x-api-key', secretName: 'APOLLO_API_KEY',
    tokenHelp: 'Create an API key under Settings then Integrations then API in your Apollo account.',
  },
  endpoints: [
    {
      id: 'enrich-person', displayName: 'Look up a person', method: 'POST', path: '/api/v1/people/match',
      class: 'read',
      // Apollo wants these on the query string even on POST.
      body: 'query',
      params: {
        email: { type: 'string', help: 'The email address to look up.' },
        first_name: { type: 'string', help: 'Used together with the last name.' },
        last_name: { type: 'string', help: 'Used together with the first name.' },
        name: { type: 'string', help: 'The full name, as one field.' },
        organization_name: { type: 'string', help: 'The employer, current or previous.' },
        domain: { type: 'string', help: 'The employer website domain, like apollo.io.' },
        linkedin_url: { type: 'string', help: 'The LinkedIn profile address.' },
        reveal_personal_emails: { type: 'boolean', help: 'Also return personal email addresses. Spends extra credits.' },
      },
      picks: [
        { field: 'full_name', from: 'person.name' },
        { field: 'person_email', from: 'person.email' },
        { field: 'title', from: 'person.title' },
        { field: 'company', from: 'person.organization.name' },
        { field: 'person_linkedin', from: 'person.linkedin_url' },
      ],
    },
    {
      id: 'enrich-organization', displayName: 'Look up a company', method: 'GET', path: '/api/v1/organizations/enrich',
      class: 'read',
      params: {
        domain: { type: 'string', help: 'The company website domain, like apollo.io - no www or @.' },
        name: { type: 'string', help: 'The company name.' },
        linkedin_url: { type: 'string', help: 'The company LinkedIn page address.' },
        website: { type: 'string', help: 'The full website address.' },
      },
      picks: [
        { field: 'company_name', from: 'organization.name' },
        { field: 'website_url', from: 'organization.website_url' },
        { field: 'industry', from: 'organization.industry' },
        { field: 'employees', from: 'organization.estimated_num_employees' },
        { field: 'city', from: 'organization.city' },
        { field: 'country', from: 'organization.country' },
      ],
    },
  ],
  inside: {
    // Enrichments land once per app; every user reads the same rows.
    tables: [
      {
        name: 'people', displayName: 'People',
        rowSchema: { 'full-name': 'string', 'person-email': 'string', title: 'string', company: 'string', 'person-linkedin': 'string' },
        grain: 'app',
      },
      {
        name: 'companies', displayName: 'Companies',
        rowSchema: { domain: 'string', 'company-name': 'string', 'website-url': 'string', industry: 'string', employees: 'number', city: 'string', country: 'string' },
        grain: 'app',
      },
    ],
    watchers: [],
  },
  settings: [
    { id: 'default_domain', label: 'Company domain', kind: 'text', help: 'The domain looked up when a call leaves it unset.' },
  ],
  fixtures: [
    {
      endpoint: 'enrich-person',
      params: { email: 'tim@apollo.io' },
      status: 200,
      response: {
        person: {
          id: '64a7ff0cc4dfae00013df1a5',
          first_name: 'Tim', last_name: 'Zheng', name: 'Tim Zheng',
          email: 'tim@apollo.io', email_status: 'verified',
          title: 'Founder & CEO',
          linkedin_url: 'http://www.linkedin.com/in/tim-zheng-677ba010',
          organization_id: '5e66b6381e05b4008c8331b8',
          organization: {
            name: 'Apollo.io',
            industry: 'information technology & services',
            website_url: 'http://www.apollo.io',
          },
        },
      },
    },
    {
      endpoint: 'enrich-organization',
      params: { domain: 'apollo.io' },
      status: 200,
      response: {
        organization: {
          id: '5e66b6381e05b4008c8331b8',
          name: 'Apollo.io',
          website_url: 'http://www.apollo.io',
          linkedin_url: 'http://www.linkedin.com/company/apolloio',
          industry: 'information technology & services',
          estimated_num_employees: 1600,
          city: 'San Francisco', state: 'California', country: 'United States',
          founded_year: 2015,
        },
      },
    },
  ],
};
