/**
 * Customer.io API preset.
 *
 * Reads use the App API (Bearer App API key); writes use the Track API, which
 * takes HTTP Basic with the Site ID and Track API key — two optional fields.
 *
 * Facts cross-checked against Customer.io's App and Track API docs, the
 * Airbyte source-customer-io manifest (api / api-eu host, start/limit paging,
 * campaign, newsletter, segment, message, activity streams) and the n8n
 * Customer.io node (customer upsert, event track, segment add/remove). Only
 * facts about the vendor's API are recorded here.
 */

module.exports = {
  id: 'customer-io',
  title: 'Customer.io',
  description: 'Campaigns, newsletters, broadcasts and their metrics, segments and members, messages, activities and people; identify people and track events.',
  docsUrl: 'https://docs.customer.io/integrations/api/app/',
  baseUrl: null,
  baseUrlPlaceholder: 'https://api.customer.io/v1',
  baseUrlHelp: 'https://api.customer.io/v1 for a US account, https://api-eu.customer.io/v1 for an EU account.',

  credentials: [
    { key: 'App API key', label: 'App API key', placeholder: 'Bearer key', helpText: 'Customer.io → Settings → Account Settings → API Credentials → App API Keys → Create App API Key.' },
    { key: 'Site ID', label: 'Site ID (for sending rows)', placeholder: 'Track API site id', optional: true,
      helpText: 'Only to send rows: Settings → Workspace Settings → API Credentials → Track API Keys → Site ID.' },
    { key: 'Track API key', label: 'Track API key (for sending rows)', placeholder: 'Track API key', optional: true,
      helpText: 'Only to send rows: the API Key next to that Site ID.' },
  ],

  headers: { Authorization: 'Bearer {App API key}', Accept: 'application/json' },

  test: { path: '/workspaces', identityField: 'workspaces.0.name' },

  pagination: 'Send limit (≤ 1000 for most); while response.data.next is a non-empty string, request again with start=<next>.',

  endpoints: [
    { path: '/campaigns', rows: '`campaigns` array', label: 'Campaigns' },
    { path: '/campaigns/{campaign_id}/metrics', rows: '`metric` object (series by period)', label: 'A campaign\'s metrics', params: 'period=days|weeks|months, steps (number of periods), type=email|sms|push' },
    { path: '/newsletters', rows: '`newsletters` array', label: 'Newsletters (one-off sends)', params: 'limit, start' },
    { path: '/newsletters/{newsletter_id}/metrics', rows: '`metric` object', label: 'A newsletter\'s metrics' },
    { path: '/broadcasts', rows: '`broadcasts` array', label: 'API-triggered broadcasts' },
    { path: '/segments', rows: '`segments` array', label: 'Segments' },
    { path: '/segments/{segment_id}/membership', rows: '`identifiers` array', label: 'People in a segment', params: 'limit, start' },
    { path: '/messages', rows: '`messages` array', label: 'Messages sent (with delivery metrics)', params: 'start_ts, end_ts, type, metric=delivered|opened|clicked, limit, start' },
    { path: '/activities', rows: '`activities` array', label: 'Activity log', params: 'type, name, limit, start' },
    { path: '/customers/{customer_id}/attributes', rows: '`customer` object', label: 'One person\'s attributes', params: 'id_type=id|email|cio_id' },
  ],

  notes: [
    'Timestamps are unix seconds.',
    'App API rate limit: 10 requests a second.',
  ],

  writes: {
    endpoints: [
      { method: 'POST', path: 'https://track.customer.io/api/v2/batch', label: 'Identify people and track events (batch)', batch: 100, upsert: 'identifiers (email or id)',
        body: '{ batch: [{ type: "person", identifiers: { email } | { id }, action: "identify", attributes: { first_name, plan, … } }, '
          + '{ type: "person", identifiers: { id }, action: "event", name: "purchased", attributes: { amount } }] }',
        notes: 'Auth is HTTP Basic, NOT the App API key: Authorization: "Basic " + Buffer.from(`${site id}:${track key}`).toString("base64") using the '
          + 'Site ID and Track API key placeholders. EU accounts use https://track-eu.customer.io. Each batch must stay under 500 KB.' },
    ],
    notes: ['Sending rows needs the Site ID and Track API key fields filled on the connection.'],
  },
};
