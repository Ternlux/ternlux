/**
 * Freshdesk API preset.
 *
 * Endpoint and field facts cross-checked against the vendor's public API docs,
 * the Airbyte source connector and the n8n node / credential for it. Only facts
 * about the vendor's API are recorded here; no code from either project.
 */

module.exports = {
  id: 'freshdesk',
  title: 'Freshdesk',
  description: 'Tickets, conversations, contacts, companies, agents, groups and satisfaction ratings.',
  docsUrl: 'https://developers.freshdesk.com/api/',
  baseUrl: null,
  baseUrlPlaceholder: 'https://yourcompany.freshdesk.com/api/v2',
  baseUrlHelp: 'Your helpdesk address followed by /api/v2.',

  credentials: [
    {
      key: 'API key',
      label: 'API key',
      placeholder: 'Your Freshdesk API key',
      helpText: 'Freshdesk → your profile picture → Profile settings → View API key.',
    },
  ],

  // Freshdesk takes the key as the Basic-auth user name and any password ("X").
  basicAuth: { username: '{API key}', password: 'X' },
  headers: {},

  test: { path: '/agents/me', identityField: 'contact.name' },

  pagination: 'Page paging. Send per_page (max 100) and page starting at 1; keep going while the response has a '
    + '`link` header with rel="next" (or a full page came back).',

  endpoints: [
    { path: '/tickets', rows: 'top-level array', label: 'Tickets', params: 'per_page, page, updated_since=<ISO-8601>, order_by=updated_at, order_type=asc, include=requester,stats,description', notes: 'Without updated_since only tickets from the last 30 days are returned. Listing stops at page 300 — narrow with updated_since for more.' },
    { path: '/tickets/{id}/conversations', rows: 'top-level array', label: 'Replies and notes on a ticket', params: 'per_page, page' },
    { path: '/contacts', rows: 'top-level array', label: 'Contacts', params: 'per_page, page, updated_since, state=verified|unverified|blocked|deleted' },
    { path: '/companies', rows: 'top-level array', label: 'Companies', params: 'per_page, page' },
    { path: '/agents', rows: 'top-level array', label: 'Agents', params: 'per_page, page' },
    { path: '/groups', rows: 'top-level array', label: 'Groups', params: 'per_page, page' },
    { path: '/time_entries', rows: 'top-level array', label: 'Time entries', params: 'per_page, page, executed_after, executed_before' },
    { path: '/surveys/satisfaction_ratings', rows: 'top-level array', label: 'Satisfaction ratings', params: 'per_page, page, created_since' },
    { path: '/ticket_fields', rows: 'top-level array', label: 'Ticket field definitions (status / priority codes, custom fields)' },
  ],

  notes: [
    'status and priority are numbers (status 2=Open, 3=Pending, 4=Resolved, 5=Closed; priority 1=Low … 4=Urgent).',
    'Custom fields are under custom_fields (cf_…). On 429, wait for Retry-After.',
  ],
};
