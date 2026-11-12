/**
 * Front API preset.
 *
 * Facts cross-checked against Front's Core API docs and the Airbyte
 * source-front manifest (https://api2.frontapp.com/, Bearer token,
 * _pagination.next paging, conversation/inbox/contact/teammate streams).
 * n8n has no Front node. Only facts about the vendor's API are recorded here.
 */

module.exports = {
  id: 'front',
  title: 'Front',
  description: 'Conversations and messages, inboxes, contacts, accounts, teammates, tags and events.',
  docsUrl: 'https://dev.frontapp.com/reference/introduction',
  baseUrl: 'https://api2.frontapp.com',

  credentials: [
    { key: 'API token', label: 'API token', placeholder: 'eyJ…', helpText: 'Front → Settings → Developers → API tokens → Create API token (choose the scopes and inboxes it may read).' },
  ],

  headers: { Authorization: 'Bearer {API token}', Accept: 'application/json' },

  test: { path: '/me', identityField: 'name' },

  pagination: 'Send limit (≤ 100); while response.data._pagination.next is set, GET that full URL.',

  endpoints: [
    { path: '/conversations', rows: '`_results` array', label: 'Conversations', params: 'limit, q[statuses][]=open|archived|assigned|unassigned, sort_by=date, sort_order=desc' },
    { path: '/conversations/search/{query}', rows: '`_results` array', label: 'Search conversations', params: 'query, e.g. "after:1735689600 is:open tag:tag_123" (URL-encoded)' },
    { path: '/conversations/{conversation_id}/messages', rows: '`_results` array', label: 'Messages of a conversation' },
    { path: '/inboxes', rows: '`_results` array', label: 'Inboxes' },
    { path: '/contacts', rows: '`_results` array', label: 'Contacts', params: 'limit, q[updated_after]=<unix seconds>' },
    { path: '/accounts', rows: '`_results` array', label: 'Accounts (companies)' },
    { path: '/teammates', rows: '`_results` array', label: 'Teammates' },
    { path: '/tags', rows: '`_results` array', label: 'Tags' },
    { path: '/events', rows: '`_results` array', label: 'Activity events (assign, tag, archive, reply…)', params: 'q[types][]=assign|archive|outbound|inbound…, q[after]=<unix seconds>' },
  ],

  notes: [
    'Timestamps are unix seconds with decimals.',
    'Rate limit depends on the plan (50–500 requests a minute); on 429 wait Retry-After seconds.',
  ],

  writes: {
    endpoints: [
      { method: 'POST', path: '/contacts', label: 'Create a contact', batch: 1, upsert: null,
        body: '{ name, handles: [{ source: "email", handle: "a@b.com" }], description?, links?, custom_fields?: { … } }' },
      { method: 'PATCH', path: '/contacts/{contact_id}', label: 'Update a contact (alt:email:a@b.com works as the id)', batch: 1, upsert: 'contact id or alt:email:<email>', body: '{ name?, description?, custom_fields? }' },
      { method: 'POST', path: '/accounts', label: 'Create an account', batch: 1, upsert: null, body: '{ name, domains?: ["acme.com"], external_id?, custom_fields? }' },
      { method: 'PATCH', path: '/accounts/{account_id}', label: 'Update an account', batch: 1, upsert: 'id', body: '{ …fields }' },
    ],
    notes: ['A contact id can be written as alt:email:<address>, so an update by email needs no lookup; a 404 means create it instead.'],
  },
};
