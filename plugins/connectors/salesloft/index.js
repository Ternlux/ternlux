/**
 * Salesloft connector — people, accounts, cadences and memberships, steps,
 * email and call activities, meetings, notes and users, plus creating and
 * updating people and accounts. Signs in with the user's own Salesloft app.
 *
 * API facts cross-checked against Salesloft's API v2 docs, the Airbyte
 * source-salesloft manifest (https://api.salesloft.com/v2, token endpoint,
 * per_page 100 paging, updated_at filters) — n8n has no Salesloft node. No
 * code from either project.
 */

const BASE = 'https://api.salesloft.com/v2';

module.exports = {
  type: 'connector',
  id: 'salesloft',
  name: 'Salesloft',
  dbCategory: 'API',

  oauth: {
    authorizeUrl: 'https://accounts.salesloft.com/oauth/authorize',
    tokenUrl: 'https://accounts.salesloft.com/oauth/token',
    scopes: [],
    clientIdLabel: 'Application ID',
    clientIdHelp: 'Salesloft → Settings → Your Applications → OAuth Applications → your app → Application Id.',
  },

  apiReference: {
    title: 'Salesloft API v2',
    docsUrl: 'https://developers.salesloft.com/docs/api/',
    baseUrl: BASE,
    headers: { Authorization: 'Bearer {accessToken}', Accept: 'application/json' },
    test: { path: '/me', identity: (d) => d.data?.email || d.data?.name },
    pagination: 'Send per_page=100 and page=1; read response.data.metadata.paging.next_page and request again while it is set.',
    endpoints: [
      { method: 'GET', path: '/people', label: 'People', rows: '`data` array', params: 'per_page, page, updated_at[gt]=<ISO-8601>, email_addresses[]=a@b.com, account_id[]=…, sort_by=updated_at' },
      { method: 'GET', path: '/accounts', label: 'Accounts', rows: '`data` array', params: 'per_page, page, updated_at[gt], domain=…' },
      { method: 'GET', path: '/cadences', label: 'Cadences', rows: '`data` array' },
      { method: 'GET', path: '/cadence_memberships', label: 'Who is on which cadence', rows: '`data` array', params: 'person_id, cadence_id, currently_on_cadence=true, updated_at[gt]' },
      { method: 'GET', path: '/steps', label: 'Cadence steps', rows: '`data` array', params: 'cadence_id' },
      { method: 'GET', path: '/activities/emails', label: 'Emails (with open/click/reply counts)', rows: '`data` array', params: 'updated_at[gt], person_id' },
      { method: 'GET', path: '/activities/calls', label: 'Calls', rows: '`data` array', params: 'updated_at[gt], person_id' },
      { method: 'GET', path: '/call_data_records', label: 'Call data records (duration, recording)', rows: '`data` array' },
      { method: 'GET', path: '/meetings', label: 'Meetings', rows: '`data` array', params: 'start_time[gt]' },
      { method: 'GET', path: '/notes', label: 'Notes', rows: '`data` array' },
      { method: 'GET', path: '/users', label: 'Users', rows: '`data` array' },
      { method: 'GET', path: '/account_stages', label: 'Account stages', rows: '`data` array' },
    ],
    notes: [
      'Related records are objects { id, _href } (person.account, owner) — keep the id.',
      'Rate limit: 600 cost points a minute per team; 429 includes Retry-After.',
    ],
    writes: {
      endpoints: [
        { method: 'POST', path: '/people', label: 'Create a person', batch: 1, upsert: null,
          body: '{ email_address, first_name, last_name, title?, phone?, account_id?, person_stage_id?, custom_fields?: { … } }' },
        { method: 'PUT', path: '/people/{id}', label: 'Update a person', batch: 1, upsert: 'id', body: '{ …fields to change }' },
        { method: 'GET', path: '/people?email_addresses[]={email}', label: 'Find a person by email first', batch: 1, upsert: null, body: '—' },
        { method: 'POST', path: '/accounts', label: 'Create an account', batch: 1, upsert: null, body: '{ name, domain, … }' },
        { method: 'PUT', path: '/accounts/{id}', label: 'Update an account', batch: 1, upsert: 'id', body: '{ …fields }' },
        { method: 'POST', path: '/cadence_memberships', label: 'Add a person to a cadence', batch: 1, upsert: null, body: 'query: person_id, cadence_id' },
      ],
      notes: ['A person needs email_address or phone + last_name. Creating an existing email returns 422 — look up by email and PUT instead.'],
    },
  },

  configSchema: { fields: [] },
  metadata: {
    displayName: 'Salesloft',
    description: 'People, accounts, cadences, emails, calls and meetings; create and update people and accounts',
    version: '1.0.0',
  },
};
