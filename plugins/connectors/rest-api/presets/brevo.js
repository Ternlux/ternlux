/**
 * Brevo (formerly Sendinblue) API preset.
 *
 * Facts cross-checked against Brevo's API v3 docs, the Airbyte source-brevo
 * manifest (https://api.brevo.com/v3/, api-key header, limit/offset paging,
 * modifiedSince, contacts/lists/campaigns/CRM streams) and the n8n Brevo node
 * (contact upsert, attribute, sender, email operations). Only facts about the
 * vendor's API are recorded here.
 */

module.exports = {
  id: 'brevo',
  title: 'Brevo',
  description: 'Contacts, lists, segments, email and SMS campaigns with stats, transactional email events, CRM deals, companies and tasks.',
  docsUrl: 'https://developers.brevo.com/reference/getting-started-1',
  baseUrl: 'https://api.brevo.com/v3',

  credentials: [
    { key: 'API key', label: 'API key', placeholder: 'xkeysib-…', helpText: 'Brevo → your name (top right) → SMTP & API → API keys → Generate a new API key.' },
  ],

  headers: { 'api-key': '{API key}', Accept: 'application/json' },

  test: { path: '/account', identityField: 'email' },

  pagination: 'Send limit (contacts ≤ 1000, most others ≤ 50/100) and offset; request again with offset += limit while offset < response.data.count.',

  endpoints: [
    { path: '/contacts', rows: '`contacts` array (attributes under contacts[i].attributes)', label: 'Contacts', params: 'limit, offset, modifiedSince=<ISO>, sort=desc' },
    { path: '/contacts/lists', rows: '`lists` array', label: 'Lists' },
    { path: '/contacts/lists/{listId}/contacts', rows: '`contacts` array', label: 'Contacts of a list', params: 'limit, offset, modifiedSince' },
    { path: '/contacts/segments', rows: '`segments` array', label: 'Segments' },
    { path: '/contacts/attributes', rows: '`attributes` array', label: 'Contact attribute definitions' },
    { path: '/emailCampaigns', rows: '`campaigns` array', label: 'Email campaigns with statistics', params: 'statistics=globalStats|linksStats|statsByDomain, status=sent, startDate, endDate, limit, offset' },
    { path: '/smsCampaigns', rows: '`campaigns` array', label: 'SMS campaigns', params: 'status, limit, offset' },
    { path: '/smtp/statistics/events', rows: '`events` array', label: 'Transactional email events (delivered, opened, clicked, bounced)', params: 'startDate, endDate (≤ 90 days), event, email, limit (≤ 5000), offset' },
    { path: '/smtp/statistics/aggregatedReport', rows: 'one object', label: 'Transactional email totals for a period', params: 'startDate, endDate | days' },
    { path: '/crm/deals', rows: '`items` array', label: 'CRM deals', params: 'limit, offset, sort' },
    { path: '/companies', rows: '`items` array', label: 'CRM companies', params: 'limit, page' },
  ],

  notes: [
    'Contact attribute names are UPPERCASE (FIRSTNAME, LASTNAME, SMS).',
    'Rate limits depend on the endpoint and plan; on 429 wait for x-sib-ratelimit-reset seconds.',
  ],

  writes: {
    endpoints: [
      { method: 'POST', path: '/contacts/import', label: 'Import contacts (create or update) into lists', batch: 5000, upsert: 'email',
        body: '{ jsonBody: [{ email, attributes: { FIRSTNAME, LASTNAME } }], listIds: [<id>], updateExistingContacts: true, emptyContactsAttributes: false }',
        notes: 'Asynchronous; the response has a processId.' },
      { method: 'POST', path: '/contacts', label: 'Create or update one contact', batch: 1, upsert: 'email (with updateEnabled: true)',
        body: '{ email, attributes?: { FIRSTNAME, … }, listIds?: [<id>], updateEnabled: true }' },
      { method: 'POST', path: '/companies', label: 'Create a CRM company', batch: 1, upsert: null, body: '{ name, attributes?: { domain, … } }' },
      { method: 'POST', path: '/crm/deals', label: 'Create a CRM deal', batch: 1, upsert: null, body: '{ name, attributes?: { amount, deal_stage, … } }' },
    ],
    notes: ['Use /contacts/import for many rows — it matches on email, so re-runs update.'],
  },
};
