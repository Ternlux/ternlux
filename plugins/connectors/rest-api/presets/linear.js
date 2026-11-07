/**
 * Linear API preset (GraphQL).
 *
 * Endpoint and field facts cross-checked against the vendor's public API docs,
 * the Airbyte source connector and the n8n node / credential for it. Only facts
 * about the vendor's API are recorded here; no code from either project.
 */

module.exports = {
  id: 'linear',
  title: 'Linear',
  description: 'Issues, projects, cycles, teams, users and comments (GraphQL).',
  docsUrl: 'https://linear.app/developers/graphql',
  baseUrl: 'https://api.linear.app',

  credentials: [
    {
      key: 'API key',
      label: 'Personal API key',
      placeholder: 'lin_api_…',
      helpText: 'Linear → Settings → Account → Security & access → Personal API keys → New API key.',
    },
  ],

  // A personal API key is sent as-is — no "Bearer" prefix (that is for OAuth tokens).
  headers: {
    Authorization: '{API key}',
    'Content-Type': 'application/json',
  },

  test: { method: 'POST', path: '/graphql', body: { query: '{ viewer { id name } }' }, identityField: 'data.viewer.name' },

  pagination: 'Every request is POST /graphql with JSON { query, variables }. Connections take first (max 250) and after; '
    + 'select pageInfo { hasNextPage endCursor } and nodes { … }, then repeat with after=<endCursor> while hasNextPage is true. '
    + 'Errors come back as response.data.errors (sometimes with HTTP 200) — treat them as failures.',

  endpoints: [
    { method: 'POST', path: '/graphql', rows: 'data.issues.nodes', label: 'Issues', operation: 'issues', params: 'query { issues(first: 100, after: $after, filter: { updatedAt: { gt: "2026-01-01" } }) { nodes { id identifier title priority estimate createdAt updatedAt completedAt state { name type } assignee { name email } team { key } project { name } labels { nodes { name } } } pageInfo { hasNextPage endCursor } } }' },
    { method: 'POST', path: '/graphql', rows: 'data.projects.nodes', label: 'Projects', operation: 'projects', params: 'projects(first, after) { nodes { id name state progress startDate targetDate lead { name } } pageInfo { … } }' },
    { method: 'POST', path: '/graphql', rows: 'data.cycles.nodes', label: 'Cycles', operation: 'cycles', params: 'cycles(first, after) { nodes { id number name startsAt endsAt progress team { key } } pageInfo { … } }' },
    { method: 'POST', path: '/graphql', rows: 'data.teams.nodes', label: 'Teams', operation: 'teams', params: 'teams(first, after) { nodes { id key name } pageInfo { … } }' },
    { method: 'POST', path: '/graphql', rows: 'data.users.nodes', label: 'Users', operation: 'users', params: 'users(first, after) { nodes { id name email active } pageInfo { … } }' },
    { method: 'POST', path: '/graphql', rows: 'data.comments.nodes', label: 'Comments', operation: 'comments', params: 'comments(first, after) { nodes { id body createdAt user { name } issue { identifier } } pageInfo { … } }' },
    { method: 'POST', path: '/graphql', rows: 'data.workflowStates.nodes', label: 'Workflow states', operation: 'workflowStates', params: 'workflowStates(first, after) { nodes { id name type team { key } } pageInfo { … } }' },
  ],

  notes: [
    'Nested objects (state, assignee, team) come back as objects — flatten the fields you select into columns.',
    'Rate limits are by request count and query complexity; ask only for the fields you need.',
  ],
};
