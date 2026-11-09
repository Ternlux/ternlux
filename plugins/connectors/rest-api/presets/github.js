/**
 * GitHub REST API preset.
 *
 * Endpoint and field facts cross-checked against the public GitHub REST docs,
 * the Airbyte `source-github` connector and the n8n GitHub node. Only facts
 * about GitHub's API are recorded here; no code from either project.
 */

module.exports = {
  id: 'github',
  title: 'GitHub',
  description: 'Repositories, issues, pull requests, commits, releases and Actions runs.',
  docsUrl: 'https://docs.github.com/en/rest',
  baseUrl: 'https://api.github.com',

  credentials: [
    {
      key: 'Personal access token',
      label: 'Personal access token',
      placeholder: 'github_pat_… or ghp_…',
      helpText: 'Create one under GitHub → Settings → Developer settings → Personal access tokens. '
        + 'A fine-grained token with read-only access to the repositories you need is enough.',
    },
  ],

  // `{Personal access token}` is replaced with the saved value of that key.
  headers: {
    Authorization: 'Bearer {Personal access token}',
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  },

  // Validates the token itself, without needing a repository name.
  test: { path: '/user', identityField: 'login' },

  pagination: 'Pass per_page=100 (the maximum). Follow the URL in the `Link` response header '
    + 'marked rel="next" (axios: response.headers.link) until there is no rel="next". '
    + 'Do not build page numbers yourself.',

  endpoints: [
    { path: '/user/repos', rows: 'top-level array', label: 'Repositories the token can see', params: 'visibility, affiliation, sort=updated, direction' },
    { path: '/orgs/{org}/repos', rows: 'top-level array', label: 'Repositories of an organization', params: 'type, sort, direction' },
    { path: '/users/{username}/repos', rows: 'top-level array', label: 'Public repositories of a user' },
    { path: '/repos/{owner}/{repo}', rows: 'single object', label: 'One repository (stars, forks, open issues)' },
    { path: '/repos/{owner}/{repo}/issues', rows: 'top-level array', label: 'Issues', params: 'state=open|closed|all, since=ISO-8601 (updated after), sort=created|updated|comments, direction, labels', notes: 'Also returns pull requests; rows with a `pull_request` key are PRs — drop them for issues only.' },
    { path: '/repos/{owner}/{repo}/pulls', rows: 'top-level array', label: 'Pull requests', params: 'state=open|closed|all, sort=created|updated, direction, base, head' },
    { path: '/repos/{owner}/{repo}/commits', rows: 'top-level array', label: 'Commits', params: 'sha (branch), since, until, author, path', notes: 'Author and date live under commit.author.' },
    { path: '/repos/{owner}/{repo}/issues/comments', rows: 'top-level array', label: 'Issue and PR comments', params: 'since, sort, direction' },
    { path: '/repos/{owner}/{repo}/pulls/comments', rows: 'top-level array', label: 'Pull request review comments', params: 'since, sort, direction' },
    { path: '/repos/{owner}/{repo}/releases', rows: 'top-level array', label: 'Releases' },
    { path: '/repos/{owner}/{repo}/branches', rows: 'top-level array', label: 'Branches' },
    { path: '/repos/{owner}/{repo}/tags', rows: 'top-level array', label: 'Tags' },
    { path: '/repos/{owner}/{repo}/labels', rows: 'top-level array', label: 'Labels' },
    { path: '/repos/{owner}/{repo}/milestones', rows: 'top-level array', label: 'Milestones', params: 'state, sort, direction' },
    { path: '/repos/{owner}/{repo}/collaborators', rows: 'top-level array', label: 'Collaborators', notes: 'Needs push access to the repository.' },
    { path: '/repos/{owner}/{repo}/stargazers', rows: 'top-level array', label: 'Stargazers', notes: 'Send Accept: application/vnd.github.star+json to get starred_at per row.' },
    { path: '/repos/{owner}/{repo}/deployments', rows: 'top-level array', label: 'Deployments' },
    { path: '/repos/{owner}/{repo}/actions/workflows', rows: '`workflows` array', label: 'Actions workflows' },
    { path: '/repos/{owner}/{repo}/actions/runs', rows: '`workflow_runs` array', label: 'Actions workflow runs', params: 'status, branch, event, created (date range like 2026-01-01..2026-02-01)' },
    { path: '/repos/{owner}/{repo}/stats/contributors', rows: 'top-level array', label: 'Contributor activity', notes: 'Can answer 202 with an empty body while GitHub computes the stats; wait a few seconds and retry.' },
    { path: '/repos/{owner}/{repo}/traffic/popular/paths', rows: 'top-level array', label: 'Top content paths (last 14 days)', notes: 'Needs push access.' },
    { path: '/repos/{owner}/{repo}/traffic/popular/referrers', rows: 'top-level array', label: 'Top referrers (last 14 days)', notes: 'Needs push access.' },
    { path: '/orgs/{org}/members', rows: 'top-level array', label: 'Organization members' },
    { path: '/orgs/{org}/teams', rows: 'top-level array', label: 'Organization teams' },
  ],

  notes: [
    'Ask the user for owner/repo (or org) when the request does not name them; never guess.',
    'Rate limit: 5,000 requests/hour per token. On 403 or 429 with `Retry-After` or `X-RateLimit-Reset`, wait before retrying.',
    'Timestamps are ISO-8601 strings in UTC.',
  ],

  writes: {
    endpoints: [
      { method: 'POST', path: '/repos/{owner}/{repo}/issues', label: 'Create an issue', batch: 1, upsert: null,
        body: '{ title, body?, labels?: [], assignees?: [] }', notes: 'On a public repository the issue is public.' },
      { method: 'PATCH', path: '/repos/{owner}/{repo}/issues/{issue_number}', label: 'Update an issue', batch: 1, upsert: 'issue number', body: '{ title?, body?, state?, labels? }' },
    ],
    notes: ['Content creation has a secondary rate limit — pause about a second between issues. Needs Issues: Read and write on the token.'],
  },
};
