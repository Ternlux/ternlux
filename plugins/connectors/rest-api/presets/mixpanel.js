/**
 * Mixpanel API preset.
 *
 * Facts cross-checked against Mixpanel's Query, Export and Ingestion API docs,
 * the Airbyte source-mixpanel docs (service-account auth, export / engage /
 * funnels / cohorts / annotations streams, EU residency hosts). n8n has no
 * Mixpanel node. Only facts about the vendor's API are recorded here.
 */

module.exports = {
  id: 'mixpanel',
  title: 'Mixpanel',
  description: 'Raw events (export), user profiles, segmentation, funnels, retention, cohorts and annotations; import events.',
  docsUrl: 'https://developer.mixpanel.com/reference/overview',
  baseUrl: null,
  baseUrlPlaceholder: 'https://mixpanel.com/api',
  baseUrlHelp: 'https://mixpanel.com/api, or https://eu.mixpanel.com/api (EU residency) / https://in.mixpanel.com/api (India).',

  credentials: [
    { key: 'Username', label: 'Service account username', placeholder: 'name.abc123.mp-service-account', helpText: 'Mixpanel → Organization settings → Service accounts → Add service account (role Consumer or higher, with access to the project).' },
    { key: 'Secret', label: 'Service account secret', placeholder: 'secret', helpText: 'Shown once when the service account is created.' },
    { key: 'Project ID', label: 'Project ID', placeholder: '1234567', usedIn: 'query', helpText: 'Project settings → Overview → Project ID.' },
  ],

  basicAuth: { username: '{Username}', password: '{Secret}' },
  headers: { Accept: 'application/json' },

  test: { path: '/app/me', identityField: 'results.name' },

  pagination: 'Engage: send page (from 0) and the session_id from the first response; stop when results come back empty. '
    + 'Export has no paging: it streams every event in the date range.',

  endpoints: [
    { method: 'GET', path: '/2.0/export', rows: 'newline-delimited JSON — request with responseType "text" and parse with tools.parseJsonLines; each { event, properties }',
      label: 'Raw events (export)', params: 'project_id, from_date=YYYY-MM-DD, to_date=YYYY-MM-DD, event=["Signed Up"] (JSON), where=<expression>, limit',
      notes: 'The export lives on another host: https://data.mixpanel.com/api/2.0/export (EU: data-eu.mixpanel.com, India: data-in.mixpanel.com) — write the full URL. '
        + 'Keep ranges short (a day to a week) on busy projects.' },
    { method: 'POST', path: '/2.0/engage', rows: '`results` array (each { $distinct_id, $properties })', label: 'User profiles', params: 'project_id; form body: where=<expression>, output_properties=["$email","plan"], session_id, page' },
    { path: '/2.0/segmentation', rows: '`data.values` object (series by date)', label: 'Event counts over time, optionally split by a property',
      params: 'project_id, event, from_date, to_date, unit=day|week|month, on=properties["plan"], type=general|unique' },
    { path: '/2.0/events', rows: '`data.values` object', label: 'Totals for several events', params: 'project_id, event=["A","B"] (JSON), type=general|unique, unit, from_date, to_date' },
    { path: '/2.0/funnels', rows: '`data` object keyed by date', label: 'A saved funnel\'s conversion by step', params: 'project_id, funnel_id, from_date, to_date, unit' },
    { path: '/2.0/funnels/list', rows: 'the body is the array', label: 'Saved funnels', params: 'project_id' },
    { path: '/2.0/retention', rows: 'object keyed by cohort date', label: 'Retention', params: 'project_id, from_date, to_date, born_event, event, unit' },
    { method: 'POST', path: '/2.0/cohorts/list', rows: 'the body is the array', label: 'Cohorts', params: 'project_id' },
    { path: '/2.0/insights', rows: '`series` object', label: 'A saved Insights report', params: 'project_id, bookmark_id' },
    { path: '/app/projects/{project_id}/annotations', rows: '`results` array', label: 'Annotations', params: 'fromDate, toDate' },
  ],

  notes: [
    'Every query needs project_id (the Project ID field).',
    'Query API rate limit: 60 queries an hour and 5 concurrent per project; Export: 60 an hour, 3 a second.',
    'Dates are in the project\'s timezone.',
  ],

  writes: {
    endpoints: [
      { method: 'POST', path: 'https://api.mixpanel.com/import?strict=1&project_id={project_id}', label: 'Import events (historical or server-side)', batch: 2000, upsert: '$insert_id (deduplicated)',
        body: '[{ event: "Purchase", properties: { time: <unix seconds or ms>, distinct_id, $insert_id: "<unique per event>", amount } }]',
        notes: 'Same service-account Basic auth. EU: api-eu.mixpanel.com. With strict=1 the response lists failed_records by index.' },
    ],
    notes: ['Give every event a stable $insert_id so re-runs do not double-count.'],
  },
};
