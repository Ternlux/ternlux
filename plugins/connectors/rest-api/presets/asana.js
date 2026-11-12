/**
 * Asana API preset.
 *
 * Facts cross-checked against Asana's API docs, the Airbyte source-asana
 * manifest (https://app.asana.com/api/1.0/, Bearer PAT, offset paging,
 * workspace/project/task/story streams) and the n8n Asana node (task,
 * subtask, project, user, comment operations). Only facts about the vendor's
 * API are recorded here.
 */

module.exports = {
  id: 'asana',
  title: 'Asana',
  description: 'Workspaces, teams, projects, sections, tasks, subtasks, stories (comments), tags, users and custom fields.',
  docsUrl: 'https://developers.asana.com/reference/rest-api-reference',
  baseUrl: 'https://app.asana.com/api/1.0',

  credentials: [
    { key: 'Personal access token', label: 'Personal access token', placeholder: '2/1234…', helpText: 'Asana → My settings → Apps → Developer apps → Personal access tokens → Create new token.' },
  ],

  headers: { Authorization: 'Bearer {Personal access token}', Accept: 'application/json' },

  test: { path: '/users/me', identityField: 'data.email' },

  pagination: 'Send limit (≤ 100); while response.data.next_page is set, request again with offset=<next_page.offset>.',

  endpoints: [
    { path: '/workspaces', rows: '`data` array', label: 'Workspaces (find the workspace gid)' },
    { path: '/projects', rows: '`data` array', label: 'Projects', params: 'workspace=<gid> or team=<gid>, archived=false, opt_fields=name,owner.name,due_on,current_status_update.text' },
    { path: '/tasks', rows: '`data` array', label: 'Tasks of a project, section, or assignee',
      params: 'project=<gid> | section=<gid> | (assignee=<gid>&workspace=<gid>), modified_since=<ISO>, completed_since=now (incomplete only), '
        + 'opt_fields=name,completed,completed_at,due_on,assignee.name,memberships.section.name,custom_fields.name,custom_fields.display_value,created_at,modified_at',
      notes: 'Without opt_fields you get only gid and name.' },
    { path: '/tasks/{task_gid}/subtasks', rows: '`data` array', label: 'Subtasks of a task', params: 'opt_fields' },
    { path: '/tasks/{task_gid}/stories', rows: '`data` array', label: 'Comments and activity on a task', params: 'opt_fields=type,text,created_at,created_by.name' },
    { path: '/projects/{project_gid}/sections', rows: '`data` array', label: 'Sections of a project' },
    { path: '/users', rows: '`data` array', label: 'Users of a workspace', params: 'workspace=<gid>, opt_fields=name,email' },
    { path: '/teams/{team_gid}/projects', rows: '`data` array', label: 'Projects of a team' },
    { path: '/workspaces/{workspace_gid}/tasks/search', rows: '`data` array', label: 'Search tasks (premium workspaces)', params: 'text, assignee.any, projects.any, modified_at.after, completed, sort_by=modified_at, opt_fields' },
  ],

  notes: [
    'Ids are string gids. Dates (due_on) are YYYY-MM-DD; timestamps ISO-8601.',
    'Rate limit: 1,500 requests a minute on paid plans (150 free); on 429 wait Retry-After seconds.',
  ],

  writes: {
    endpoints: [
      { method: 'POST', path: '/tasks', label: 'Create a task', batch: 1, upsert: null,
        body: '{ data: { name, projects: ["<project gid>"], assignee?: "<user gid>|me", due_on?: "YYYY-MM-DD", notes?, custom_fields?: { "<field gid>": <value> } } }' },
      { method: 'PUT', path: '/tasks/{task_gid}', label: 'Update a task', batch: 1, upsert: 'task gid', body: '{ data: { completed?, due_on?, name?, … } }' },
      { method: 'POST', path: '/tasks/{task_gid}/stories', label: 'Comment on a task', batch: 1, upsert: null, body: '{ data: { text } }' },
      { method: 'POST', path: '/batch', label: 'Up to 10 actions in one request', batch: 10, upsert: null,
        body: '{ data: { actions: [{ method: "post", relative_path: "/tasks", data: { … } }, …] } }' },
    ],
    notes: ['No upsert: to update instead of duplicating, list the project\'s tasks (opt_fields=name) and match on name or a custom field.'],
  },
};
