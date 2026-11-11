/**
 * Zendesk Support API preset.
 *
 * Facts cross-checked against Zendesk's Support API docs, the Airbyte
 * source-zendesk-support manifest (https://<subdomain>.zendesk.com, cursor
 * paging with page[size], incremental ticket export, Retry-After) and the n8n
 * Zendesk node (ticket, user, organization, ticket field). Only facts about
 * the vendor's API are recorded here.
 */

module.exports = {
  id: 'zendesk',
  title: 'Zendesk',
  description: 'Tickets, comments, users, organizations, groups, ticket metrics, satisfaction ratings and Help Center articles.',
  docsUrl: 'https://developer.zendesk.com/api-reference/',
  baseUrl: null,
  baseUrlPlaceholder: 'https://yourcompany.zendesk.com',
  baseUrlHelp: 'Your Zendesk address, as you see it in the browser.',

  credentials: [
    { key: 'Email', label: 'Agent email', placeholder: 'you@company.com', helpText: 'The email of the agent or admin who created the token.' },
    { key: 'API token', label: 'API token', placeholder: 'Zendesk API token', helpText: 'Admin Center → Apps and integrations → APIs → Zendesk API → enable Token access → Add API token.' },
  ],

  basicAuth: { username: '{Email}/token', password: '{API token}' },
  headers: { Accept: 'application/json' },

  test: { path: '/api/v2/users/me.json', identityField: 'user.email' },

  pagination: 'Cursor paging: send page[size]=100; while response.data.meta.has_more is true, GET response.data.links.next (a full URL). '
    + 'Incremental exports return after_url and end_of_stream instead — follow after_url until end_of_stream is true.',

  endpoints: [
    { path: '/api/v2/tickets', rows: '`tickets` array', label: 'Tickets', params: 'page[size], sort=-updated_at' },
    { path: '/api/v2/incremental/tickets/cursor.json', rows: '`tickets` array', label: 'Every ticket changed since a time (best for syncing)',
      params: 'start_time=<unix seconds> (first call), then cursor=<after_cursor>; per_page ≤ 1000', notes: 'Includes deleted tickets (status "deleted").' },
    { path: '/api/v2/tickets/{ticket_id}/comments', rows: '`comments` array', label: 'A ticket\'s comments (conversation)' },
    { path: '/api/v2/ticket_metrics', rows: '`ticket_metrics` array', label: 'Ticket metrics (reply time, resolution time, reopens)' },
    { path: '/api/v2/satisfaction_ratings', rows: '`satisfaction_ratings` array', label: 'CSAT ratings', params: 'score=good|bad, start_time, end_time' },
    { path: '/api/v2/users', rows: '`users` array', label: 'Users (end users and agents)', params: 'role=end-user|agent|admin, page[size]' },
    { path: '/api/v2/organizations', rows: '`organizations` array', label: 'Organizations' },
    { path: '/api/v2/groups', rows: '`groups` array', label: 'Groups' },
    { path: '/api/v2/ticket_fields', rows: '`ticket_fields` array', label: 'Ticket field definitions (names for custom_fields ids)' },
    { path: '/api/v2/search.json', rows: '`results` array', label: 'Search', params: 'query=type:ticket status:open created>2025-01-01, sort_by, sort_order; at most 1,000 results' },
    { path: '/api/v2/help_center/articles', rows: '`articles` array', label: 'Help Center articles' },
  ],

  notes: [
    'Custom ticket fields are in custom_fields as { id, value }; map ids to titles with /api/v2/ticket_fields.',
    'Rate limits depend on the plan (200–700 requests a minute); on 429 wait Retry-After seconds.',
  ],

  writes: {
    endpoints: [
      { method: 'POST', path: '/api/v2/users/create_or_update_many', label: 'Create or update users (match on email or external_id)', batch: 100, upsert: 'email or external_id',
        body: '{ users: [{ name, email, external_id?, phone?, organization_id?, user_fields?: { … } }] }', notes: 'Asynchronous: returns a job_status; poll its url for results.' },
      { method: 'POST', path: '/api/v2/organizations/create_or_update', label: 'Create or update an organization', batch: 1, upsert: 'name or external_id', body: '{ organization: { name, external_id?, domain_names? } }' },
      { method: 'POST', path: '/api/v2/tickets/create_many', label: 'Create tickets', batch: 100, upsert: null,
        body: '{ tickets: [{ subject, comment: { body }, requester: { name, email }, priority?, tags?, custom_fields?: [{ id, value }] }] }', notes: 'Asynchronous (job_status).' },
      { method: 'PUT', path: '/api/v2/tickets/update_many', label: 'Update tickets by id', batch: 100, upsert: 'id', body: '{ tickets: [{ id, status?, tags?, … }] }' },
    ],
    notes: ['Bulk endpoints answer with a job_status; poll GET <job_status.url> with tools.sleep until status is "completed", then read results for per-row errors.'],
  },
};
