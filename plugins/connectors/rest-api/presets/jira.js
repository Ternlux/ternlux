/**
 * Jira Cloud API preset.
 *
 * Endpoint and field facts cross-checked against the vendor's public API docs,
 * the Airbyte source connector and the n8n node / credential for it. Only facts
 * about the vendor's API are recorded here; no code from either project.
 */

module.exports = {
  id: 'jira',
  title: 'Jira',
  description: 'Issues (JQL), projects, comments, worklogs, users, boards and sprints.',
  docsUrl: 'https://developer.atlassian.com/cloud/jira/platform/rest/v3/intro/',
  baseUrl: null,
  baseUrlPlaceholder: 'https://your-site.atlassian.net',
  baseUrlHelp: 'Your Jira Cloud site address, as it appears in the browser.',

  credentials: [
    {
      key: 'Email',
      label: 'Atlassian account email',
      placeholder: 'you@company.com',
      helpText: 'The email of the account the API token belongs to.',
    },
    {
      key: 'API token',
      label: 'API token',
      placeholder: 'ATATT…',
      helpText: 'id.atlassian.com/manage-profile/security/api-tokens → Create API token.',
    },
  ],

  basicAuth: { username: '{Email}', password: '{API token}' },
  headers: {
    Accept: 'application/json',
  },

  test: { path: '/rest/api/3/myself', identityField: 'displayName' },

  pagination: 'Issue search (/rest/api/3/search/jql) uses tokens: send maxResults (max 100) and, while the response '
    + 'has nextPageToken, request again with nextPageToken=<it>; stop when isLast is true or no token comes back. '
    + 'Most other lists use startAt/maxResults: add maxResults to startAt until isLast is true (or startAt >= total).',

  endpoints: [
    { path: '/rest/api/3/search/jql', rows: '`issues` array', label: 'Issues (JQL search)', params: 'jql (required, e.g. project = ABC AND updated >= -7d ORDER BY updated), fields=summary,status,assignee,created,updated or *all, maxResults, nextPageToken, expand=changelog', notes: 'Fields are under issue.fields (status.name, assignee.displayName, priority.name…) — flatten them. The old /rest/api/3/search is retired. The JQL must restrict the search (a project, a date such as created >= -365d, an assignee…): an unbounded query such as "ORDER BY created" alone is refused with HTTP 400 "Unbounded JQL queries are not allowed". For every issue across projects, read /rest/api/3/project/search first and use project in (A, B).' },
    { path: '/rest/api/3/project/search', rows: '`values` array', label: 'Projects', params: 'startAt, maxResults, query, expand=lead,description' },
    { path: '/rest/api/3/issue/{issueIdOrKey}/comment', rows: '`comments` array', label: 'Comments on an issue', params: 'startAt, maxResults', notes: 'Bodies are Atlassian Document Format (nested JSON), not plain text.' },
    { path: '/rest/api/3/issue/{issueIdOrKey}/worklog', rows: '`worklogs` array', label: 'Worklogs on an issue', params: 'startAt, maxResults, startedAfter=<ms epoch>' },
    { path: '/rest/api/3/issue/{issueIdOrKey}/changelog', rows: '`values` array', label: 'Change history of an issue', params: 'startAt, maxResults' },
    { path: '/rest/api/3/users/search', rows: 'top-level array', label: 'Users', params: 'startAt, maxResults', notes: 'No isLast here — stop when a page comes back shorter than maxResults.' },
    { path: '/rest/api/3/field', rows: 'top-level array', label: 'Field definitions (find customfield_ ids)' },
    { path: '/rest/api/3/status', rows: 'top-level array', label: 'Statuses' },
    { path: '/rest/agile/1.0/board', rows: '`values` array', label: 'Boards', params: 'startAt, maxResults, projectKeyOrId, type=scrum|kanban' },
    { path: '/rest/agile/1.0/board/{boardId}/sprint', rows: '`values` array', label: 'Sprints of a board', params: 'startAt, maxResults, state=active|closed|future' },
    { path: '/rest/agile/1.0/sprint/{sprintId}/issue', rows: '`issues` array', label: 'Issues in a sprint', params: 'startAt, maxResults, jql, fields' },
  ],

  notes: [
    'Custom fields appear as customfield_NNNNN; read /rest/api/3/field to name them.',
    'Dates are ISO-8601 strings with an offset, e.g. 2026-01-05T10:31:00.000+0000.',
    'On 429, wait for Retry-After.',
  ],

  writes: {
    endpoints: [
      { method: 'POST', path: '/rest/api/3/issue/bulk', label: 'Create issues', batch: 50, upsert: null,
        body: '{ issueUpdates: [{ fields: { project: { key }, summary, issuetype: { name: "Task" }, description?: <ADF doc>, priority?: { name }, labels?: [] } }] }',
        notes: 'Answers 201 with `issues` created and `errors` for rejected entries (failedElementNumber) — count those as failed.' },
      { method: 'PUT', path: '/rest/api/3/issue/{issueIdOrKey}', label: 'Update an issue', batch: 1, upsert: 'issue key', body: '{ fields: { … } }' },
    ],
    notes: [
      'description is Atlassian Document Format: { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text }] }] }.',
      'issuetype names come from the project (Task, Bug, Story…); read /rest/api/3/project/{key} if unsure.',
    ],
  },
};
