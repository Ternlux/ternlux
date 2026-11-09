/**
 * Intercom API preset.
 *
 * Endpoint and field facts cross-checked against the vendor's public API docs,
 * the Airbyte source connector and the n8n node / credential for it. Only facts
 * about the vendor's API are recorded here; no code from either project.
 */

module.exports = {
  id: 'intercom',
  title: 'Intercom',
  description: 'Contacts, companies, conversations, tickets, admins, tags and segments.',
  docsUrl: 'https://developers.intercom.com/docs/references/rest-api/api.intercom.io',
  baseUrl: 'https://api.intercom.io',

  credentials: [
    {
      key: 'Access token',
      label: 'Access token',
      placeholder: 'dG9rOm…',
      helpText: 'Intercom Developer Hub → your app → Authentication → copy the access token.',
    },
  ],

  headers: {
    Authorization: 'Bearer {Access token}',
    Accept: 'application/json',
    'Intercom-Version': '2.11',
  },

  test: { path: '/me', identityField: 'name' },

  pagination: 'Cursor paging. Send per_page (max 150). While response.data.pages.next.starting_after is set, request again '
    + 'with starting_after=<it> (for POST …/search, put it in the body as pagination: { per_page, starting_after }).',

  endpoints: [
    { path: '/contacts', rows: '`data` array', label: 'Contacts (users and leads)', params: 'per_page, starting_after', notes: 'contact.companies is only a reference list — { data: [{ id, type, url }], total_count } with no names. For company names, page through /companies (not /companies/scroll) and join on id; a contact with total_count 0 has no company.' },
    { method: 'POST', path: '/contacts/search', rows: '`data` array', label: 'Contacts matching a filter', params: 'JSON body: { query: { field: "updated_at", operator: ">", value: <unix seconds> }, pagination: { per_page, starting_after } }' },
    { path: '/companies', rows: '`data` array', label: 'Companies', params: 'per_page (max 60 — more is a 400), page', notes: 'Page-numbered: request page=1,2,… until pages.next is null. Use this for company lists and names. Only past 10,000 companies use GET /companies/scroll, and carefully: a workspace allows ONE open scroll (a second answers 400 scroll_exists), and the loop must stop on the first page whose data is empty — it always returns a scroll_param, and calling on after the end fails.' },
    { path: '/conversations', rows: '`conversations` array', label: 'Conversations', params: 'per_page, starting_after' },
    { method: 'POST', path: '/conversations/search', rows: '`conversations` array', label: 'Conversations matching a filter', params: 'JSON body: { query: { field: "updated_at", operator: ">", value: <unix seconds> }, pagination }' },
    { path: '/conversations/{id}', rows: 'single object', label: 'One conversation with its parts (messages)' },
    { method: 'POST', path: '/tickets/search', rows: '`tickets` array', label: 'Tickets', params: 'JSON body: { query, pagination }' },
    { path: '/admins', rows: '`admins` array', label: 'Admins (teammates)' },
    { path: '/teams', rows: '`teams` array', label: 'Teams' },
    { path: '/tags', rows: '`data` array', label: 'Tags' },
    { path: '/segments', rows: '`segments` array', label: 'Segments' },
  ],

  notes: [
    'Timestamps are Unix seconds.',
    'EU and Australian workspaces use api.eu.intercom.io / api.au.intercom.io — change the Base URL for those.',
    'On 429, wait until the X-RateLimit-Reset time.',
  ],

  writes: {
    endpoints: [
      { method: 'POST', path: '/contacts', label: 'Create a contact (user or lead)', batch: 1, upsert: null,
        body: '{ role: "user" | "lead", email, name?, phone?, external_id?, custom_attributes? }',
        notes: 'A user whose email or external_id already exists answers 409 — search, then PUT /contacts/{id} to update.' },
      { method: 'PUT', path: '/contacts/{id}', label: 'Update a contact', batch: 1, upsert: 'id', body: '{ …fields to change }' },
      { method: 'POST', path: '/contacts/search', label: 'Find contacts (for updates)', batch: 1, upsert: null,
        body: '{ query: { field: "email", operator: "=", value } }' },
      { method: 'POST', path: '/companies', label: 'Create or update a company', batch: 1, upsert: 'company_id',
        body: '{ company_id, name, plan?, size?, website?, custom_attributes? }' },
      { method: 'POST', path: '/contacts/{id}/companies', label: 'Attach a contact to a company', batch: 1, upsert: null, body: '{ id: "<company id>" }' },
    ],
    notes: [
      'One record per request. custom_attributes must already be defined in Intercom (Settings → Data); an unknown one is a 400.',
      'A company\'s standard fields go at the TOP level, not in custom_attributes: company_id, name, plan, size (employee count, integer), website, industry, monthly_spend, remote_created_at.',
      'A contact\'s standard fields are top level too: role, external_id, email, phone, name, avatar, signed_up_at, last_seen_at, owner_id, unsubscribed_from_emails.',
    ],
  },
};
