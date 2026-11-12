/**
 * Sentry API preset (sentry.io, EU region or self-hosted).
 *
 * Facts cross-checked against Sentry's Web API docs, the Airbyte source-sentry
 * manifest (https://<host>/api/0, Bearer auth token, Link-header cursor paging
 * with results="true|false", projects/issues/events/releases streams) and the
 * n8n Sentry.io node (organization, project, team, issue, release, event).
 * Only facts about the vendor's API are recorded here.
 */

module.exports = {
  id: 'sentry',
  title: 'Sentry',
  description: 'Organizations, projects, issues, events, releases, teams and Discover queries over errors and transactions.',
  docsUrl: 'https://docs.sentry.io/api/',
  baseUrl: null,
  baseUrlPlaceholder: 'https://sentry.io/api/0',
  baseUrlHelp: 'https://sentry.io/api/0 (US), https://de.sentry.io/api/0 (EU), or https://<your host>/api/0 for self-hosted.',

  credentials: [
    { key: 'Auth token', label: 'Auth token', placeholder: 'sntryu_…', helpText: 'Sentry → Settings → Account → Personal Tokens (or Developer Settings → Organization tokens) with org:read, project:read and event:read.' },
  ],

  headers: { Authorization: 'Bearer {Auth token}', Accept: 'application/json' },

  test: { path: '/organizations/', identityField: '0.slug' },

  pagination: 'Read the Link response header: while the rel="next" part has results="true", request again with cursor=<its cursor value>. '
    + 'Send per_page (≤ 100) where supported.',

  endpoints: [
    { path: '/organizations/', rows: 'the body is the array', label: 'Organizations (find the org slug)' },
    { path: '/organizations/{org_slug}/projects/', rows: 'the body is the array', label: 'Projects' },
    { path: '/organizations/{org_slug}/issues/', rows: 'the body is the array', label: 'Issues across the organization',
      params: 'query=is:unresolved level:error, statsPeriod=24h|14d|"", project=<id>, sort=date|freq|new, limit' },
    { path: '/projects/{org_slug}/{project_slug}/events/', rows: 'the body is the array', label: 'Error events of a project', params: 'full=true, statsPeriod' },
    { path: '/organizations/{org_slug}/issues/{issue_id}/events/', rows: 'the body is the array', label: 'Events of one issue' },
    { path: '/organizations/{org_slug}/releases/', rows: 'the body is the array', label: 'Releases', params: 'project, query' },
    { path: '/organizations/{org_slug}/events/', rows: '`data` array', label: 'Discover query (aggregate errors or transactions)',
      params: 'field=title&field=count()&field=project, query=event.type:error, statsPeriod=14d, sort=-count, per_page' },
    { path: '/organizations/{org_slug}/stats_v2/', rows: '`groups` array', label: 'Usage stats (events accepted, dropped)', params: 'field=sum(quantity), groupBy=outcome|category, interval=1d, statsPeriod=30d' },
    { path: '/organizations/{org_slug}/teams/', rows: 'the body is the array', label: 'Teams' },
  ],

  notes: [
    'Issue counts are strings; firstSeen / lastSeen are ISO-8601.',
    'Rate limits are per token and endpoint; on 429 wait Retry-After seconds.',
  ],

  writes: {
    endpoints: [
      { method: 'PUT', path: '/organizations/{org_slug}/issues/?id={id}&id={id2}', label: 'Bulk update issues (resolve, ignore, assign)', batch: 100, upsert: 'issue id',
        body: '{ status?: "resolved"|"unresolved"|"ignored", assignedTo?: "user:<id>"|"team:<id>", hasSeen? }' },
    ],
    notes: ['Sentry is mostly read here; the token needs event:write to change issues.'],
  },
};
