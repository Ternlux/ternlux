/**
 * SendGrid (Twilio SendGrid) API preset.
 *
 * Endpoint and field facts cross-checked against the vendor's public API docs,
 * the Airbyte source connector and the n8n node / credential for it. Only facts
 * about the vendor's API are recorded here; no code from either project.
 */

module.exports = {
  id: 'sendgrid',
  title: 'SendGrid',
  description: 'Marketing lists, single sends, stats, templates and suppressions (bounces, blocks, unsubscribes).',
  docsUrl: 'https://www.twilio.com/docs/sendgrid/api-reference',
  baseUrl: 'https://api.sendgrid.com',

  credentials: [
    {
      key: 'API key',
      label: 'API key',
      placeholder: 'SG.…',
      helpText: 'SendGrid → Settings → API Keys → Create API Key (Restricted Access with read permissions is enough).',
    },
  ],

  headers: {
    Authorization: 'Bearer {API key}',
  },

  test: { path: '/v3/scopes' },

  pagination: 'Two styles. Marketing endpoints return `result` with _metadata.next (a full URL) — follow it until it is missing. '
    + 'Suppression endpoints take limit (max 500) and offset — add limit to offset until a page comes back shorter than limit.',

  endpoints: [
    { path: '/v3/marketing/lists', rows: '`result` array', label: 'Contact lists', params: 'page_size (max 1000), page_token' },
    { path: '/v3/marketing/singlesends', rows: '`result` array', label: 'Single sends (campaigns)', params: 'page_size, page_token' },
    { path: '/v3/marketing/stats/singlesends', rows: '`results` array', label: 'Single send stats', params: 'start_date, end_date, page_size, page_token' },
    { path: '/v3/marketing/segments/2.0', rows: '`results` array', label: 'Segments' },
    { path: '/v3/stats', rows: 'top-level array (one row per day, metrics under stats[0].metrics)', label: 'Global email stats', params: 'start_date=YYYY-MM-DD (required), end_date, aggregated_by=day|week|month' },
    { path: '/v3/templates', rows: '`result` array', label: 'Templates', params: 'generations=dynamic|legacy, page_size (required, max 200), page_token' },
    { path: '/v3/suppression/bounces', rows: 'top-level array', label: 'Bounces', params: 'limit, offset, start_time, end_time (Unix seconds)' },
    { path: '/v3/suppression/blocks', rows: 'top-level array', label: 'Blocks', params: 'limit, offset, start_time, end_time' },
    { path: '/v3/suppression/spam_reports', rows: 'top-level array', label: 'Spam reports', params: 'limit, offset, start_time, end_time' },
    { path: '/v3/suppression/unsubscribes', rows: 'top-level array', label: 'Global unsubscribes', params: 'limit, offset, start_time, end_time' },
    { path: '/v3/suppression/invalid_emails', rows: 'top-level array', label: 'Invalid emails', params: 'limit, offset, start_time, end_time' },
    { path: '/v3/asm/groups', rows: 'top-level array', label: 'Unsubscribe groups' },
  ],

  notes: [
    'Full contact exports are asynchronous (POST /v3/marketing/contacts/exports, then poll) — prefer lists, stats and suppressions.',
    'Suppression "created" values are Unix seconds.',
  ],

  writes: {
    endpoints: [
      { method: 'PUT', path: '/v3/marketing/contacts', label: 'Add or update contacts (optionally into lists)', batch: 30000, upsert: 'email',
        body: '{ list_ids?: ["<list id>"], contacts: [{ email, first_name?, last_name?, city?, country?, custom_fields?: { <field id>: value } }] }',
        notes: 'Asynchronous: 202 with a job_id; contacts appear shortly after. Up to 30,000 contacts or 6 MB per request.' },
    ],
    notes: ['custom_fields are keyed by field id (GET /v3/marketing/field_definitions). Needs Marketing write access on the key.'],
  },
};
