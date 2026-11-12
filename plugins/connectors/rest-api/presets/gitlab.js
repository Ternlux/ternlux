/**
 * GitLab API preset (gitlab.com or self-managed).
 *
 * Facts cross-checked against GitLab's REST API v4 docs, the Airbyte
 * source-gitlab docs and manifest (projects, groups, issues, merge requests,
 * pipelines, jobs, deployments streams; per_page/page paging; RateLimit-Reset)
 * and the n8n GitLab node (issue, release, file, repository operations). Only
 * facts about the vendor's API are recorded here.
 */

module.exports = {
  id: 'gitlab',
  title: 'GitLab',
  description: 'Projects, groups, issues, merge requests, commits, pipelines, jobs, deployments, releases and members.',
  docsUrl: 'https://docs.gitlab.com/api/rest/',
  baseUrl: null,
  baseUrlPlaceholder: 'https://gitlab.com/api/v4',
  baseUrlHelp: 'https://gitlab.com/api/v4 for GitLab.com, or https://<your GitLab host>/api/v4 for self-managed.',

  credentials: [
    { key: 'Access token', label: 'Personal access token', placeholder: 'glpat-…', helpText: 'GitLab → avatar → Edit profile → Access tokens → Add new token with the read_api scope (api to send rows).' },
  ],

  headers: { 'PRIVATE-TOKEN': '{Access token}', Accept: 'application/json' },

  test: { path: '/user', identityField: 'username' },

  pagination: 'Send per_page (≤ 100) and page; request again while the x-next-page response header is not empty. '
    + 'For more than 10,000 results use keyset paging (pagination=keyset&order_by=id&sort=asc) and follow the Link rel="next" header.',

  endpoints: [
    { path: '/projects', rows: 'the body is the array', label: 'Projects you are a member of', params: 'membership=true, simple=true, per_page, page, last_activity_after=<ISO>' },
    { path: '/groups', rows: 'the body is the array', label: 'Groups', params: 'per_page, page' },
    { path: '/projects/{id}/issues', rows: 'the body is the array', label: 'Issues of a project', params: 'state=opened|closed|all, updated_after=<ISO>, labels, per_page, page',
      notes: '{id} is the numeric project id or the URL-encoded path (group%2Fproject).' },
    { path: '/groups/{id}/issues', rows: 'the body is the array', label: 'Issues of every project in a group', params: 'state, updated_after, per_page, page' },
    { path: '/projects/{id}/merge_requests', rows: 'the body is the array', label: 'Merge requests', params: 'state=opened|merged|closed|all, updated_after, per_page, page' },
    { path: '/projects/{id}/repository/commits', rows: 'the body is the array', label: 'Commits', params: 'ref_name, since, until, with_stats=true, per_page, page' },
    { path: '/projects/{id}/pipelines', rows: 'the body is the array', label: 'CI/CD pipelines', params: 'updated_after, status, ref, per_page, page' },
    { path: '/projects/{id}/jobs', rows: 'the body is the array', label: 'CI/CD jobs (duration, status, runner)', params: 'scope[]=failed|success, per_page, page' },
    { path: '/projects/{id}/deployments', rows: 'the body is the array', label: 'Deployments', params: 'environment, updated_after, per_page, page' },
    { path: '/projects/{id}/releases', rows: 'the body is the array', label: 'Releases' },
    { path: '/projects/{id}/members/all', rows: 'the body is the array', label: 'Project members (incl. inherited)' },
  ],

  notes: [
    'Issues and merge requests have a project-wide iid (shown in the UI) and a global id; URLs for one issue use the iid.',
    'GitLab.com allows about 2,000 authenticated requests a minute; on 429 wait for RateLimit-Reset.',
  ],

  writes: {
    endpoints: [
      { method: 'POST', path: '/projects/{id}/issues', label: 'Create an issue', batch: 1, upsert: null, body: '{ title, description?, labels?: "a,b", assignee_ids?, due_date?, milestone_id? }' },
      { method: 'PUT', path: '/projects/{id}/issues/{issue_iid}', label: 'Update an issue', batch: 1, upsert: 'issue iid', body: '{ title?, state_event?: "close"|"reopen", labels?, … }' },
      { method: 'POST', path: '/projects/{id}/issues/{issue_iid}/notes', label: 'Comment on an issue', batch: 1, upsert: null, body: '{ body }' },
      { method: 'GET', path: '/projects/{id}/issues?search={title}&in=title', label: 'Find an issue by title first', batch: 1, upsert: null, body: '—' },
    ],
    notes: ['The token needs the api scope to write. Issues on a public project are public.'],
  },
};
