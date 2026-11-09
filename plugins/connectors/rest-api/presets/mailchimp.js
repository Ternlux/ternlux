/**
 * Mailchimp Marketing API preset.
 *
 * Endpoint and field facts cross-checked against the vendor's public API docs,
 * the Airbyte source connector and the n8n node / credential for it. Only facts
 * about the vendor's API are recorded here; no code from either project.
 */

module.exports = {
  id: 'mailchimp',
  title: 'Mailchimp',
  description: 'Audiences (lists), members, campaigns, reports and automations.',
  docsUrl: 'https://mailchimp.com/developer/marketing/api/',
  baseUrl: null,
  baseUrlPlaceholder: 'https://us21.api.mailchimp.com/3.0',
  baseUrlHelp: 'Your data center is the part of the API key after the dash (key …-us21 → https://us21.api.mailchimp.com/3.0).',

  credentials: [
    {
      key: 'API key',
      label: 'API key',
      placeholder: '…-us21',
      helpText: 'Mailchimp → Profile → Extras → API keys → Create A Key.',
    },
  ],

  headers: {
    Authorization: 'apikey {API key}',
  },

  test: { path: '/ping', identityField: 'health_status' },

  pagination: 'Offset paging. Send count (max 1000) and offset; add count to offset until offset >= response.data.total_items. '
    + 'Use fields= / exclude_fields= to keep responses small.',

  endpoints: [
    { path: '/lists', rows: '`lists` array', label: 'Audiences (lists)', params: 'count, offset, fields' },
    { path: '/lists/{list_id}/members', rows: '`members` array', label: 'Members of an audience', params: 'count, offset, status=subscribed|unsubscribed|cleaned|pending, since_last_changed=<ISO-8601>, fields', notes: 'Merge fields (FNAME, LNAME…) are under merge_fields; tags under tags[].name.' },
    { path: '/lists/{list_id}/segments', rows: '`segments` array', label: 'Segments and tags of an audience', params: 'count, offset' },
    { path: '/campaigns', rows: '`campaigns` array', label: 'Campaigns', params: 'count, offset, status=save|paused|schedule|sending|sent, since_send_time' },
    { path: '/reports', rows: '`reports` array', label: 'Campaign reports (opens, clicks, bounces)', params: 'count, offset, since_send_time' },
    { path: '/reports/{campaign_id}/email-activity', rows: '`emails` array', label: 'Per-recipient activity for a campaign', params: 'count, offset, since' },
    { path: '/reports/{campaign_id}/unsubscribed', rows: '`unsubscribes` array', label: 'Unsubscribes from a campaign', params: 'count, offset' },
    { path: '/automations', rows: '`automations` array', label: 'Classic automations', params: 'count, offset' },
  ],

  notes: [
    'Member ids are the MD5 hash of the lower-cased email address.',
    'Mailchimp allows about 10 concurrent connections per key; keep requests sequential.',
  ],

  writes: {
    endpoints: [
      { method: 'POST', path: '/lists/{list_id}', label: 'Add or update audience members', batch: 500, upsert: 'email_address',
        body: '{ members: [{ email_address, status_if_new: "subscribed", status?, merge_fields: { FNAME, LNAME }, tags: [] }], update_existing: true }',
        notes: 'Answers 200 even when some members fail: response.data.errors lists them (count as failed); new_members / updated_members are the successes.' },
      { method: 'POST', path: '/lists/{list_id}/members/{subscriber_hash}/tags', label: 'Add or remove tags on one member', batch: 1, upsert: 'subscriber_hash (MD5 of the lower-cased email)',
        body: '{ tags: [{ name, status: "active" | "inactive" }] }' },
    ],
    notes: [
      'Mailchimp rejects addresses that look fake (example.com and similar) and addresses that unsubscribed before cannot be re-subscribed by API.',
      'Adding a member does not send anything; a campaign does.',
      'An audience named by the user is found by GET /lists?count=1000 (lists[].name → id).',
    ],
  },
};
