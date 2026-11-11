/**
 * Outreach connector — prospects, accounts, opportunities, sequences and
 * their states and steps, mailings, calls, tasks and users (JSON:API), plus
 * creating and updating prospects and accounts. Signs in with the user's own
 * Outreach app.
 *
 * Outreach access tokens last about 2 hours and refresh tokens rotate; every
 * refresh is saved by the app's token store.
 *
 * API facts cross-checked against Outreach's API v2 docs, the Airbyte
 * source-outreach manifest (https://api.outreach.io/api/v2/, token endpoint,
 * links.next paging, updatedAt filters) — n8n has no Outreach node. No code
 * from either project.
 */

const BASE = 'https://api.outreach.io/api/v2';

module.exports = {
  type: 'connector',
  id: 'outreach',
  name: 'Outreach',
  dbCategory: 'API',

  oauth: {
    authorizeUrl: 'https://api.outreach.io/oauth/authorize',
    tokenUrl: 'https://api.outreach.io/oauth/token',
    scopes: ['users.read', 'accounts.all', 'prospects.all', 'opportunities.read', 'sequences.read', 'sequenceStates.read',
      'sequenceSteps.read', 'mailings.read', 'calls.read', 'tasks.read', 'stages.read', 'personas.read', 'mailboxes.read'],
    clientIdHelp: 'Outreach → Settings → Integrations → My apps (developer portal) → your app → API access → Client ID.',
  },

  apiReference: {
    title: 'Outreach API v2 (JSON:API)',
    docsUrl: 'https://developers.outreach.io/api/reference/overview/',
    baseUrl: BASE,
    headers: { Authorization: 'Bearer {accessToken}', Accept: 'application/vnd.api+json', 'Content-Type': 'application/vnd.api+json' },
    test: { path: '/users?page[size]=1', identity: (d) => d.data?.[0]?.attributes?.email },
    pagination: 'Send page[size]=1000; while response.data.links.next is set, GET that full URL. Sort with sort=updatedAt.',
    endpoints: [
      { method: 'GET', path: '/prospects', label: 'Prospects (people)', rows: '`data` array — fields under data[i].attributes, relations under data[i].relationships',
        params: 'filter[updatedAt]=2025-01-01..inf, filter[emails]=a@b.com, page[size], sort, fields[prospect]=firstName,lastName,emails,title,company,stage' },
      { method: 'GET', path: '/accounts', label: 'Accounts (companies)', rows: '`data` array', params: 'filter[updatedAt], filter[domain], page[size]' },
      { method: 'GET', path: '/opportunities', label: 'Opportunities', rows: '`data` array', params: 'filter[updatedAt], page[size]' },
      { method: 'GET', path: '/sequences', label: 'Sequences', rows: '`data` array' },
      { method: 'GET', path: '/sequenceStates', label: 'Who is in which sequence, and their state', rows: '`data` array', params: 'filter[state]=active|finished|paused, filter[updatedAt]' },
      { method: 'GET', path: '/sequenceSteps', label: 'Sequence steps', rows: '`data` array' },
      { method: 'GET', path: '/mailings', label: 'Emails sent (opens, clicks, replies)', rows: '`data` array', params: 'filter[updatedAt], filter[state]=delivered|replied|bounced' },
      { method: 'GET', path: '/calls', label: 'Calls', rows: '`data` array', params: 'filter[updatedAt]' },
      { method: 'GET', path: '/tasks', label: 'Tasks', rows: '`data` array', params: 'filter[state]=incomplete|complete' },
      { method: 'GET', path: '/users', label: 'Users', rows: '`data` array' },
      { method: 'GET', path: '/stages', label: 'Prospect stages', rows: '`data` array' },
    ],
    notes: [
      'Flatten each record: { id, ...attributes } plus the related ids you need (relationships.account.data.id, relationships.owner.data.id).',
      'filter ranges use "..": filter[updatedAt]=2025-01-01T00:00:00Z..inf.',
      'Rate limit: 10,000 requests an hour per user; 429 carries the reset time.',
    ],
    writes: {
      endpoints: [
        { method: 'POST', path: '/prospects', label: 'Create a prospect', batch: 1, upsert: null,
          body: '{ data: { type: "prospect", attributes: { emails: ["a@b.com"], firstName, lastName, title, company }, '
            + 'relationships?: { account: { data: { type: "account", id: 123 } } } } }' },
        { method: 'PATCH', path: '/prospects/{id}', label: 'Update a prospect', batch: 1, upsert: 'id', body: '{ data: { type: "prospect", id: <id>, attributes: { …fields to change } } }' },
        { method: 'GET', path: '/prospects?filter[emails]={email}', label: 'Find a prospect by email first (to update instead of duplicating)', batch: 1, upsert: null, body: '—' },
        { method: 'POST', path: '/accounts', label: 'Create an account', batch: 1, upsert: null, body: '{ data: { type: "account", attributes: { name, domain, … } } }' },
        { method: 'PATCH', path: '/accounts/{id}', label: 'Update an account', batch: 1, upsert: 'id', body: '{ data: { type: "account", id: <id>, attributes: { … } } }' },
      ],
      notes: ['No upsert endpoint: look the prospect up by email (or the account by domain) and PATCH it, else POST. Ids are integers.'],
    },
  },

  configSchema: { fields: [] },
  metadata: {
    displayName: 'Outreach',
    description: 'Prospects, accounts, sequences, mailings, calls and tasks; create and update prospects and accounts',
    version: '1.0.0',
  },
};
