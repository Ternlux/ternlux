/**
 * monday.com API preset (GraphQL).
 *
 * Facts cross-checked against monday.com's API v2 docs, the Airbyte
 * source-monday manifest (https://api.monday.com/v2, token auth, boards /
 * items / updates / activity log streams, items_page cursors) and the n8n
 * monday.com node (board, group, column, item, update operations). Only facts
 * about the vendor's API are recorded here.
 */

module.exports = {
  id: 'monday',
  title: 'monday.com',
  description: 'Boards, groups, columns, items and subitems with their column values, updates, users, workspaces and activity logs (GraphQL).',
  docsUrl: 'https://developer.monday.com/api-reference/docs',
  baseUrl: 'https://api.monday.com',

  credentials: [
    { key: 'API token', label: 'API token', placeholder: 'eyJhbGciOi…', helpText: 'monday.com → your avatar → Developers → My access tokens → Show (or Administration → Connections → API).' },
  ],

  headers: { Authorization: '{API token}', 'Content-Type': 'application/json' },

  test: { path: '/v2', method: 'POST', body: { query: '{ me { name email } }' }, identityField: 'data.me.email' },

  pagination: 'items_page returns { cursor, items }; request next_items_page(cursor: "<cursor>", limit: 500) while cursor is not null. '
    + 'Other lists take limit and page arguments.',

  endpoints: [
    { method: 'POST', path: '/v2', operation: 'boards', rows: '`data.boards` array', label: 'Boards with their columns and groups',
      params: 'body: { query: "{ boards(limit: 100, page: 1, state: active) { id name workspace { name } columns { id title type } groups { id title } } }" }' },
    { method: 'POST', path: '/v2', operation: 'items_page', rows: '`data.boards[0].items_page.items` array', label: 'Items of a board with column values',
      params: 'body: { query: "{ boards(ids: [<id>]) { items_page(limit: 500) { cursor items { id name group { title } updated_at column_values { id text value column { title } } } } } }" }',
      notes: 'Pivot column_values into columns by column.title (or id); `text` is the display value, `value` the raw JSON.' },
    { method: 'POST', path: '/v2', operation: 'next_items_page', rows: '`data.next_items_page.items` array', label: 'The next page of items',
      params: 'body: { query: "{ next_items_page(cursor: \\"<cursor>\\", limit: 500) { cursor items { id name column_values { id text } } } }" }' },
    { method: 'POST', path: '/v2', operation: 'items_page_by_column_values', rows: '`data.items_page_by_column_values.items` array', label: 'Find items by a column value',
      params: 'body: { query: "{ items_page_by_column_values(board_id: <id>, columns: [{ column_id: \\"email\\", column_values: [\\"a@b.com\\"] }]) { items { id name } } }" }' },
    { method: 'POST', path: '/v2', operation: 'updates', rows: '`data.updates` array', label: 'Updates (comments)', params: 'body: { query: "{ updates(limit: 100, page: 1) { id body created_at creator { name } item_id } }" }' },
    { method: 'POST', path: '/v2', operation: 'users', rows: '`data.users` array', label: 'Users', params: 'body: { query: "{ users { id name email } }" }' },
    { method: 'POST', path: '/v2', operation: 'activity_logs', rows: '`data.boards[0].activity_logs` array', label: 'Board activity log',
      params: 'body: { query: "{ boards(ids: [<id>]) { activity_logs(limit: 100, from: \\"2025-01-01T00:00:00Z\\") { event data created_at } } }" }' },
  ],

  notes: [
    'GraphQL errors arrive with HTTP 200 in response.data.errors — throw on them.',
    'Each query spends complexity budget; ask only for the fields you need. ComplexityException means slow down.',
    'Ids are numbers in queries and strings in responses.',
  ],

  writes: {
    endpoints: [
      { method: 'POST', path: '/v2', operation: 'create_item', label: 'Create an item', batch: 1, upsert: null,
        body: '{ query: "mutation ($b: ID!, $g: String, $n: String!, $v: JSON) { create_item(board_id: $b, group_id: $g, item_name: $n, column_values: $v) { id } }", '
          + 'variables: { b: <board id>, g: "<group id>", n: "<name>", v: JSON.stringify({ email: { email: "a@b.com", text: "a@b.com" }, status: { label: "Done" }, date4: { date: "2025-01-31" } }) } }' },
      { method: 'POST', path: '/v2', operation: 'change_multiple_column_values', label: 'Update an item\'s columns', batch: 1, upsert: 'item id',
        body: '{ query: "mutation ($b: ID!, $i: ID!, $v: JSON!) { change_multiple_column_values(board_id: $b, item_id: $i, column_values: $v) { id } }", variables: { … } }' },
      { method: 'POST', path: '/v2', operation: 'create_update', label: 'Post an update on an item', batch: 1, upsert: null,
        body: '{ query: "mutation ($i: ID!, $t: String!) { create_update(item_id: $i, body: $t) { id } }", variables: { i, t } }' },
    ],
    notes: [
      'column_values is a JSON STRING keyed by column id; each column type has its own shape (status { label }, date { date }, people { personsAndTeams }).',
      'No upsert: look the item up with items_page_by_column_values and change it, else create it.',
    ],
  },
};
