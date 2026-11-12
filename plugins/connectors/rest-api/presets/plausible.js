/**
 * Plausible Analytics API preset (plausible.io or self-hosted).
 *
 * Facts cross-checked against Plausible's Stats API v2 docs and the Airbyte
 * source-plausible manifest (Bearer API key, per-site stats). n8n has no
 * Plausible node. Only facts about the vendor's API are recorded here.
 */

module.exports = {
  id: 'plausible',
  title: 'Plausible',
  description: 'Visitors, pageviews, bounce rate, visit duration and goals by day, page, source, country, device and more.',
  docsUrl: 'https://plausible.io/docs/stats-api',
  baseUrl: null,
  baseUrlPlaceholder: 'https://plausible.io',
  baseUrlHelp: 'https://plausible.io, or your self-hosted Plausible address.',

  credentials: [
    { key: 'API key', label: 'Stats API key', placeholder: 'Plausible API key', helpText: 'Plausible → Account settings → API keys → New API key (Stats API).' },
    { key: 'Site', label: 'Site domain', placeholder: 'example.com', usedIn: 'body', helpText: 'The site exactly as it is named in Plausible (no https://).' },
  ],

  headers: { Authorization: 'Bearer {API key}', 'Content-Type': 'application/json' },

  test: { method: 'POST', path: '/api/v2/query', body: { site_id: '{Site}', metrics: ['visitors'], date_range: 'day' }, identityField: 'query.site_id' },

  pagination: 'v2 query: send pagination { limit (≤ 10000), offset } and request again while a full page came back.',

  endpoints: [
    { method: 'POST', path: '/api/v2/query', rows: '`results` array — each { dimensions: [...], metrics: [...] } in the order requested',
      label: 'Stats query (any metrics by any dimensions)',
      params: 'body: { site_id, metrics: ["visitors","pageviews","bounce_rate","visit_duration","events","conversion_rate"], date_range: "30d"|"month"|"year"|["2025-01-01","2025-01-31"], '
        + 'dimensions?: ["time:day","event:page","visit:source","visit:country_name","visit:device","visit:utm_campaign"], filters?: [["is","visit:country_name",["Germany"]]], '
        + 'order_by?, pagination?: { limit, offset } }',
      notes: 'site_id is the Site domain field — use its placeholder. Zip dimensions and metrics into named columns.' },
    { path: '/api/v1/stats/aggregate', rows: '`results` object', label: 'Totals (v1)', params: 'site_id, period=30d, metrics=visitors,pageviews' },
    { path: '/api/v1/stats/timeseries', rows: '`results` array', label: 'Time series (v1)', params: 'site_id, period, interval=date|month, metrics' },
    { path: '/api/v1/stats/breakdown', rows: '`results` array', label: 'Breakdown by a property (v1)', params: 'site_id, period, property=visit:source|event:page, metrics, limit, page' },
    { path: '/api/v1/stats/realtime/visitors', rows: 'a number', label: 'Current visitors', params: 'site_id' },
  ],

  notes: [
    'Rate limit: 600 requests an hour per API key.',
    'bounce_rate is a percentage; visit_duration is in seconds.',
  ],

  writes: { endpoints: [], notes: ['Plausible cannot receive rows through this connection (its Events API is for live traffic).'] },
};
