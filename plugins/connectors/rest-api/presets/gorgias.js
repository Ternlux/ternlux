/**
 * Gorgias API preset.
 *
 * Facts cross-checked against Gorgias' REST API docs and the Airbyte
 * source-gorgias manifest (https://<domain>.gorgias.com, HTTP Basic with
 * email + API key, cursor paging with limit/cursor, Retry-after). n8n has no
 * Gorgias node. Only facts about the vendor's API are recorded here.
 */

module.exports = {
  id: 'gorgias',
  title: 'Gorgias',
  description: 'Tickets and messages, customers, satisfaction surveys, users, tags, views and events.',
  docsUrl: 'https://developers.gorgias.com/reference/introduction',
  baseUrl: null,
  baseUrlPlaceholder: 'https://yourstore.gorgias.com',
  baseUrlHelp: 'Your Gorgias address (the helpdesk URL).',

  credentials: [
    { key: 'Email', label: 'Account email', placeholder: 'you@store.com', helpText: 'The email you sign in to Gorgias with.' },
    { key: 'API key', label: 'API key', placeholder: 'Gorgias REST API key', helpText: 'Gorgias → Settings → REST API → Base API key (or create one).' },
  ],

  basicAuth: { username: '{Email}', password: '{API key}' },
  headers: { Accept: 'application/json' },

  test: { path: '/api/account', identityField: 'domain' },

  pagination: 'Send limit (≤ 100); while response.data.meta.next_cursor is set, request again with cursor=<it>.',

  endpoints: [
    { path: '/api/tickets', rows: '`data` array', label: 'Tickets', params: 'limit, cursor, order_by=updated_datetime:desc, view_id' },
    { path: '/api/tickets/{ticket_id}/messages', rows: '`data` array', label: 'Messages of a ticket' },
    { path: '/api/customers', rows: '`data` array', label: 'Customers', params: 'limit, cursor, email' },
    { path: '/api/satisfaction-surveys', rows: '`data` array', label: 'Satisfaction surveys (score, comment)' },
    { path: '/api/users', rows: '`data` array', label: 'Users (agents)' },
    { path: '/api/tags', rows: '`data` array', label: 'Tags' },
    { path: '/api/views', rows: '`data` array', label: 'Views' },
    { path: '/api/events', rows: '`data` array', label: 'Events (ticket created, updated, message sent…)', params: 'types, created_datetime[gte]' },
  ],

  notes: [
    'Datetimes are ISO-8601 UTC.',
    'Rate limit: 40 requests every 20 seconds per account (more with an API key app); on 429 wait Retry-after seconds.',
  ],

  writes: {
    endpoints: [
      { method: 'POST', path: '/api/customers', label: 'Create a customer', batch: 1, upsert: null,
        body: '{ name, email, channels?: [{ type: "email", address }], data?: { … }, external_id? }' },
      { method: 'PUT', path: '/api/customers/{id}', label: 'Update a customer', batch: 1, upsert: 'id', body: '{ …fields to change }' },
      { method: 'GET', path: '/api/customers?email={email}', label: 'Find a customer by email first', batch: 1, upsert: null, body: '—' },
      { method: 'POST', path: '/api/tickets', label: 'Create a ticket', batch: 1, upsert: null,
        body: '{ customer: { email }, channel: "api", via: "api", from_agent: false, messages: [{ channel: "api", via: "api", from_agent: false, sender: { email }, body_text, subject }] }' },
    ],
    notes: ['No upsert: GET /api/customers?email=… and PUT the match, else POST.'],
  },
};
