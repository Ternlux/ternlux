/**
 * Amplitude API preset (Dashboard REST API + HTTP V2 ingestion).
 *
 * Facts cross-checked against Amplitude's Dashboard REST, Export and HTTP V2
 * API docs and the Airbyte source-amplitude manifest (HTTP Basic with API key
 * and secret key, amplitude.com / analytics.eu.amplitude.com hosts, active
 * users, average session length, cohorts, annotations, events). n8n has no
 * Amplitude node. Only facts about the vendor's API are recorded here.
 * Raw-event Export (a zip of gzipped files) is left out on purpose.
 */

module.exports = {
  id: 'amplitude',
  title: 'Amplitude',
  description: 'Event segmentation, funnels, retention, active users, session length, user activity, cohorts and annotations; send events.',
  docsUrl: 'https://amplitude.com/docs/apis/analytics/dashboard-rest',
  baseUrl: null,
  baseUrlPlaceholder: 'https://amplitude.com/api/2',
  baseUrlHelp: 'https://amplitude.com/api/2, or https://analytics.eu.amplitude.com/api/2 for EU data residency.',

  credentials: [
    { key: 'API key', label: 'API key', placeholder: 'Project API key', helpText: 'Amplitude → Settings → Organization settings → Projects → your project → General → API Key.' },
    { key: 'Secret key', label: 'Secret key', placeholder: 'Project secret key', helpText: 'Same page → Secret Key.' },
  ],

  basicAuth: { username: '{API key}', password: '{Secret key}' },
  headers: { Accept: 'application/json' },

  test: { path: '/events/list', identityField: 'data.0.name' },

  pagination: 'None — each report returns its whole result. Keep date ranges reasonable (a month or two for daily series).',

  endpoints: [
    { path: '/events/segmentation', rows: '`data.series` (arrays per group) with dates in `data.xValues` — zip them into rows', label: 'Event segmentation (counts, uniques, sums over time)',
      params: 'e={"event_type":"Purchase","group_by":[{"type":"event","value":"plan"}]} (JSON), start=YYYYMMDD, end=YYYYMMDD, m=uniques|totals|pct_dau|average|sums, i=1|7|30 (interval), s=<segment JSON>' },
    { path: '/funnels', rows: '`data` array (stepByStep, cumulative counts)', label: 'Funnel conversion', params: 'e=<event JSON> repeated per step, start, end, mode=ordered|unordered, n=active|new, cs=<seconds>' },
    { path: '/retention', rows: '`data` object', label: 'Retention', params: 'se=<start event JSON>, re=<return event JSON>, start, end, rm=bracket|rolling|n-day, i' },
    { path: '/users', rows: '`data.series` with `data.xValues`', label: 'Active or new users over time', params: 'start, end, m=active|new, i=1|7|30, g=<property to group by>' },
    { path: '/sessions/average', rows: '`data.series`', label: 'Average session length', params: 'start, end' },
    { path: '/events/list', rows: '`data` array', label: 'Event types with this week\'s totals' },
    { path: '/useractivity', rows: '`events` array', label: 'One user\'s event stream', params: 'user=<Amplitude ID>, offset, limit (≤ 1000)' },
    { path: '/annotations', rows: '`data` array', label: 'Chart annotations' },
  ],

  notes: [
    'Dates are YYYYMMDD in the project\'s timezone. Event JSON goes URL-encoded in the e / se / re parameters.',
    'Rate limit: about 5 concurrent requests and a per-hour query cost budget; 429 means wait and retry.',
    'Cohort lists live at /api/3/cohorts (one level up from the base URL).',
  ],

  writes: {
    endpoints: [
      { method: 'POST', path: 'https://api2.amplitude.com/2/httpapi', label: 'Send events (HTTP V2)', batch: 1000, upsert: 'insert_id (deduplicated for 7 days)',
        body: '{ api_key: "<API key placeholder>", events: [{ user_id | device_id, event_type, time: <ms>, insert_id, event_properties: { … }, user_properties?: { … } }] }',
        notes: 'No Basic auth here — the API key goes in the body. EU: https://api.eu.amplitude.com/2/httpapi. The response counts events_ingested.' },
    ],
    notes: ['Set insert_id per event so a re-run is deduplicated.'],
  },
};
