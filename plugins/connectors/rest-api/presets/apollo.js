/**
 * Apollo.io API preset.
 *
 * Facts from Apollo's API docs. Neither Airbyte's main catalog nor n8n has an
 * Apollo source, so endpoints were checked against Apollo's reference only.
 * Only facts about the vendor's API are recorded here.
 */

module.exports = {
  id: 'apollo',
  title: 'Apollo.io',
  description: 'Your CRM contacts, accounts, deals, sequences and users; search Apollo\'s people and company database.',
  docsUrl: 'https://docs.apollo.io/reference/authentication',
  baseUrl: 'https://api.apollo.io/api/v1',

  credentials: [
    { key: 'API key', label: 'API key', placeholder: 'Your Apollo API key', helpText: 'Apollo → Settings → Integrations → API → Create new key. A master key is needed for contacts, accounts and sequences.' },
  ],

  headers: { 'x-api-key': '{API key}', 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' },

  test: { path: '/auth/health', identityField: 'is_logged_in' },

  pagination: 'Search endpoints take page (from 1) and per_page (≤ 100) in the body; read response.data.pagination.total_pages. '
    + 'Searches stop at 50,000 records (500 pages).',

  endpoints: [
    { method: 'POST', path: '/contacts/search', rows: '`contacts` array', label: 'Contacts saved in your Apollo account', params: 'body: { q_keywords?, contact_stage_ids?, sort_by_field: "contact_last_activity_date", page, per_page }' },
    { method: 'POST', path: '/accounts/search', rows: '`accounts` array', label: 'Accounts saved in your Apollo account', params: 'body: { q_organization_name?, page, per_page }' },
    { method: 'GET', path: '/opportunities/search', rows: '`opportunities` array', label: 'Deals', params: 'page, per_page' },
    { method: 'POST', path: '/emailer_campaigns/search', rows: '`emailer_campaigns` array', label: 'Sequences', params: 'body: { page, per_page }' },
    { method: 'GET', path: '/users/search', rows: '`users` array', label: 'Users in your team' },
    { method: 'POST', path: '/mixed_people/api_search', rows: '`people` array', label: 'Search Apollo\'s people database (no emails or phones)',
      params: 'body: { person_titles?: [], person_seniorities?: [], organization_domains?: [], person_locations?: [], page, per_page }' },
    { method: 'POST', path: '/mixed_companies/search', rows: '`organizations` (and `accounts`) arrays', label: 'Search Apollo\'s company database', params: 'body: { q_organization_domains_list?: [], organization_num_employees_ranges?: ["1,10"], page, per_page }' },
  ],

  notes: [
    'Database searches cost credits on most plans; contacts/accounts searches of your own data do not.',
    'Emails and phone numbers from the database need the enrichment endpoints (people/match), which consume credits — ask before using them.',
    'Rate limits depend on the plan and are returned in x-rate-limit-* headers.',
  ],

  writes: {
    endpoints: [
      { method: 'POST', path: '/contacts', label: 'Create a contact', batch: 1, upsert: 'email when run_dedupe is true',
        body: '{ first_name, last_name, email, title?, organization_name?, account_id?, label_names?: ["…"], run_dedupe: true }' },
      { method: 'PATCH', path: '/contacts/{id}', label: 'Update a contact', batch: 1, upsert: 'id', body: '{ …fields to change }' },
      { method: 'POST', path: '/accounts', label: 'Create an account', batch: 1, upsert: null, body: '{ name, domain, phone? }' },
      { method: 'PATCH', path: '/accounts/{id}', label: 'Update an account', batch: 1, upsert: 'id', body: '{ …fields }' },
    ],
    notes: ['Send run_dedupe: true on contact creation so a re-run updates the existing contact instead of duplicating it.'],
  },
};
