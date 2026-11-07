/**
 * Klaviyo API preset.
 *
 * Endpoint and field facts cross-checked against the vendor's public API docs,
 * the Airbyte source connector and the n8n node / credential for it. Only facts
 * about the vendor's API are recorded here; no code from either project.
 * n8n has no Klaviyo node; the request shape follows Klaviyo's docs and Airbyte.
 */

module.exports = {
  id: 'klaviyo',
  title: 'Klaviyo',
  description: 'Profiles, events, metrics, lists, segments, campaigns and flows.',
  docsUrl: 'https://developers.klaviyo.com/en/reference/api_overview',
  baseUrl: 'https://a.klaviyo.com',

  credentials: [
    {
      key: 'Private API key',
      label: 'Private API key',
      placeholder: 'pk_…',
      helpText: 'Klaviyo → Settings → Account → API keys → Create Private API Key (Read-only is enough).',
    },
  ],

  headers: {
    Authorization: 'Klaviyo-API-Key {Private API key}',
    revision: '2026-01-15',
    Accept: 'application/vnd.api+json',
  },

  test: { path: '/api/accounts', identityField: 'data.0.attributes.contact_information.organization_name' },

  pagination: 'JSON:API style. Rows are in response.data.data; follow response.data.links.next (a full URL) until it is null. '
    + 'page[size] limits differ per endpoint and a size over the limit is refused with HTTP 400: profiles, events, '
    + 'list/segment profiles and campaigns allow up to 100; flows up to 50; lists, segments and templates only up to 10; '
    + 'metrics take no page[size] at all. When unsure, leave page[size] out and just follow links.next.',

  endpoints: [
    { path: '/api/profiles', rows: '`data` array', label: 'Profiles', params: 'page[size] (max 100), filter=greater-than(updated,2026-01-01T00:00:00Z), sort=updated, additional-fields[profile]=subscriptions', notes: 'Fields are under attributes (email, first_name, properties…) — flatten them next to id.' },
    { path: '/api/events', rows: '`data` array', label: 'Events (opens, clicks, orders…)', params: 'page[size] (max 100), filter=greater-than(datetime,2026-01-01T00:00:00Z), sort=datetime, include=metric,profile', notes: 'Large accounts have millions of events — always filter by datetime.' },
    { path: '/api/metrics', rows: '`data` array', label: 'Metrics (event types)', notes: 'No page[size] — sending one is a 400.' },
    { path: '/api/lists', rows: '`data` array', label: 'Lists', params: 'page[size] (max 10), filter, page[cursor]' },
    { path: '/api/lists/{id}/profiles', rows: '`data` array', label: 'Profiles in a list', params: 'page[size] (max 100)' },
    { path: '/api/segments', rows: '`data` array', label: 'Segments', params: 'page[size] (max 10)' },
    { path: '/api/segments/{id}/profiles', rows: '`data` array', label: 'Profiles in a segment', params: 'page[size] (max 100)' },
    { path: '/api/campaigns', rows: '`data` array', label: 'Campaigns', params: "filter=equals(messages.channel,'email') (a channel filter is required)" },
    { path: '/api/flows', rows: '`data` array', label: 'Flows', params: 'page[size] (max 50), filter, sort' },
    { path: '/api/templates', rows: '`data` array', label: 'Templates', params: 'page[size] (max 10)' },
  ],

  notes: [
    'Filters use Klaviyo syntax: equals(field,"x"), greater-than(field,2026-01-01T00:00:00Z), any(field,["a","b"]) — URL-encode them.',
    'On 429, wait for Retry-After.',
  ],
};
