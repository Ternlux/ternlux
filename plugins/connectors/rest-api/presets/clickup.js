/**
 * ClickUp API preset.
 *
 * Facts cross-checked against ClickUp's API v2 docs, the Airbyte
 * source-clickup-api manifest (https://api.clickup.com/api/v2/, token in the
 * Authorization header, team → space → folder → list → task streams, time
 * tracking) and the n8n ClickUp node (task, list, folder, comment, time entry,
 * goal operations). Only facts about the vendor's API are recorded here.
 */

module.exports = {
  id: 'clickup',
  title: 'ClickUp',
  description: 'Workspaces, spaces, folders, lists, tasks with custom fields, comments, time entries and goals.',
  docsUrl: 'https://developer.clickup.com/reference',
  baseUrl: 'https://api.clickup.com/api/v2',

  credentials: [
    { key: 'API token', label: 'Personal API token', placeholder: 'pk_…', helpText: 'ClickUp → your avatar → Settings → Apps → API Token → Generate.' },
  ],

  headers: { Authorization: '{API token}', 'Content-Type': 'application/json' },

  test: { path: '/user', identityField: 'user.email' },

  pagination: 'Task lists: page=0,1,2,… (100 tasks a page); stop when response.data.last_page is true. Other lists return everything at once.',

  endpoints: [
    { path: '/team', rows: '`teams` array', label: 'Workspaces (called teams in the API)' },
    { path: '/team/{team_id}/space', rows: '`spaces` array', label: 'Spaces of a workspace', params: 'archived=false' },
    { path: '/space/{space_id}/folder', rows: '`folders` array (each with its lists)', label: 'Folders of a space' },
    { path: '/folder/{folder_id}/list', rows: '`lists` array', label: 'Lists of a folder' },
    { path: '/space/{space_id}/list', rows: '`lists` array', label: 'Lists not in a folder' },
    { path: '/list/{list_id}/task', rows: '`tasks` array', label: 'Tasks of a list', params: 'page, include_closed=true, subtasks=true, date_updated_gt=<ms>, statuses[]=…' },
    { path: '/team/{team_id}/task', rows: '`tasks` array', label: 'Tasks across the whole workspace (filtered)', params: 'page, space_ids[], list_ids[], assignees[], date_updated_gt=<ms>, include_closed' },
    { path: '/task/{task_id}/comment', rows: '`comments` array', label: 'Comments on a task' },
    { path: '/team/{team_id}/time_entries', rows: '`data` array', label: 'Time entries', params: 'start_date=<ms>, end_date=<ms>, assignee=<user ids>' },
    { path: '/list/{list_id}/field', rows: '`fields` array', label: 'Custom fields of a list' },
  ],

  notes: [
    'Dates are unix MILLISECONDS as strings (due_date, date_created, date_updated).',
    'Custom field values are in task.custom_fields[] as { id, name, type, value }; dropdowns hold an option index — map it with type_config.options.',
    'Rate limit: 100 requests a minute per token (more on higher plans).',
  ],

  writes: {
    endpoints: [
      { method: 'POST', path: '/list/{list_id}/task', label: 'Create a task', batch: 1, upsert: null,
        body: '{ name, description?, assignees?: [<user id>], status?, priority?: 1-4, due_date?: <ms>, tags?: [], custom_fields?: [{ id, value }] }' },
      { method: 'PUT', path: '/task/{task_id}', label: 'Update a task', batch: 1, upsert: 'task id', body: '{ name?, status?, due_date?, … }' },
      { method: 'POST', path: '/task/{task_id}/field/{field_id}', label: 'Set one custom field', batch: 1, upsert: 'task id', body: '{ value }' },
      { method: 'POST', path: '/task/{task_id}/comment', label: 'Comment on a task', batch: 1, upsert: null, body: '{ comment_text, notify_all: false }' },
    ],
    notes: ['No upsert: list the list\'s tasks and match on name or a custom field, then PUT; else POST.'],
  },
};
