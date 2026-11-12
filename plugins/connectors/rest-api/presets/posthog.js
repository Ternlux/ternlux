/**
 * PostHog API preset (PostHog Cloud US/EU or self-hosted).
 *
 * Facts cross-checked against PostHog's API docs (HogQL query endpoint,
 * personal API keys, capture batch endpoint), the Airbyte source-posthog docs
 * (projects, events, persons, cohorts, insights, feature flags, annotations)
 * and the n8n PostHog node (capture: event, identify, alias, page/screen).
 * Only facts about the vendor's API are recorded here.
 */

module.exports = {
  id: 'posthog',
  title: 'PostHog',
  description: 'Any HogQL (SQL) query over events, persons and sessions; projects, insights, feature flags, cohorts, annotations; capture events.',
  docsUrl: 'https://posthog.com/docs/api',
  baseUrl: null,
  baseUrlPlaceholder: 'https://us.posthog.com',
  baseUrlHelp: 'https://us.posthog.com, https://eu.posthog.com, or your self-hosted PostHog address.',

  credentials: [
    { key: 'Personal API key', label: 'Personal API key', placeholder: 'phx_…', helpText: 'PostHog → Settings → Personal API keys → Create (scopes: query:read, plus project:read, person:read, insight:read as needed).' },
    { key: 'Project API key', label: 'Project API key (for sending events)', placeholder: 'phc_…', optional: true,
      helpText: 'Only to send rows: Project settings → Project API key (it is public by design).' },
  ],

  headers: { Authorization: 'Bearer {Personal API key}', 'Content-Type': 'application/json' },

  test: { path: '/api/users/@me/', identityField: 'email' },

  pagination: 'List endpoints return { results, next }; while response.data.next is set, GET that full URL. '
    + 'HogQL: page with LIMIT / OFFSET in the query itself (default LIMIT 100, max 50000 per query).',

  endpoints: [
    { method: 'POST', path: '/api/projects/{project_id}/query/', rows: '`results` array of arrays; column names in response.data.columns — zip them into objects',
      label: 'HogQL query (SQL over events, persons, sessions)',
      params: 'body: { query: { kind: "HogQLQuery", query: "SELECT toDate(timestamp) AS day, event, count() AS n FROM events WHERE timestamp > now() - INTERVAL 30 DAY GROUP BY day, event ORDER BY day LIMIT 10000" } }',
      notes: 'Tables: events (event, timestamp, distinct_id, properties.$browser…), persons (properties.email…), sessions. Prefer this over the list endpoints.' },
    { path: '/api/projects/', rows: '`results` array', label: 'Projects (find the project id)' },
    { path: '/api/projects/{project_id}/insights/', rows: '`results` array', label: 'Saved insights', params: 'saved=true, limit' },
    { path: '/api/projects/{project_id}/feature_flags/', rows: '`results` array', label: 'Feature flags' },
    { path: '/api/projects/{project_id}/cohorts/', rows: '`results` array', label: 'Cohorts' },
    { path: '/api/projects/{project_id}/persons/', rows: '`results` array', label: 'Persons', params: 'search, properties, limit' },
    { path: '/api/projects/{project_id}/annotations/', rows: '`results` array', label: 'Annotations' },
  ],

  notes: [
    'Query API rate limit: 120 queries an hour per team; list endpoints 240 a minute.',
    'Timestamps are UTC ISO-8601.',
  ],

  writes: {
    endpoints: [
      { method: 'POST', path: 'https://us.i.posthog.com/batch/', label: 'Capture events (batch)', batch: 1000, upsert: 'uuid (deduplicated)',
        body: '{ api_key: "<Project API key placeholder>", batch: [{ event, distinct_id, properties: { … }, timestamp: "<ISO>", uuid? }] }',
        notes: 'No Authorization header — the project key goes in the body. EU: https://eu.i.posthog.com/batch/; self-hosted: <your host>/batch/. '
          + 'To set person properties send event "$identify" with properties.$set.' },
    ],
    notes: ['Sending events needs the Project API key field filled on the connection.'],
  },
};
