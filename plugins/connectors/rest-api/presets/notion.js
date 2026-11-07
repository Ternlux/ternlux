/**
 * Notion API preset.
 *
 * Endpoint and field facts cross-checked against the vendor's public API docs,
 * the Airbyte source connector and the n8n node / credential for it. Only facts
 * about the vendor's API are recorded here; no code from either project.
 * Uses Notion-Version 2025-09-03, where databases hold "data sources".
 */

module.exports = {
  id: 'notion',
  title: 'Notion',
  description: 'Pages, data sources (databases), blocks, comments and users.',
  docsUrl: 'https://developers.notion.com/reference',
  baseUrl: 'https://api.notion.com',

  credentials: [
    {
      key: 'Integration token',
      label: 'Internal integration secret',
      placeholder: 'ntn_…',
      helpText: 'notion.so/profile/integrations → New integration (internal) → copy the secret. Then open each '
        + 'page or database you want to read in Notion → ••• → Connections → add the integration.',
    },
  ],

  headers: {
    Authorization: 'Bearer {Integration token}',
    'Notion-Version': '2025-09-03',
  },

  test: { path: '/v1/users/me', identityField: 'name' },

  pagination: 'Cursor paging. Send page_size (max 100). When response.data.has_more is true, send '
    + 'start_cursor=<response.data.next_cursor> — in the JSON body for POST endpoints, in the query string for GET.',

  endpoints: [
    { method: 'POST', path: '/v1/search', rows: '`results` array', label: 'Search pages and data sources', params: 'JSON body: { query, filter: { property: "object", value: "page" | "data_source" }, sort, page_size, start_cursor }' },
    { method: 'POST', path: '/v1/data_sources/{data_source_id}/query', rows: '`results` array (pages)', label: 'Rows of a database (data source)', params: 'JSON body: { filter, sorts, page_size, start_cursor }', notes: 'Each row\'s fields are under properties.<Name> with a type-specific shape (title[].plain_text, number, select.name, date.start…) — flatten them into columns.' },
    { path: '/v1/data_sources/{data_source_id}', rows: 'single object', label: 'A data source\'s schema (property names and types)' },
    { path: '/v1/databases/{database_id}', rows: 'single object', label: 'A database and its data_sources list', notes: 'Use it to find the data_source_id behind a database link.' },
    { path: '/v1/pages/{page_id}', rows: 'single object', label: 'One page and its properties' },
    { path: '/v1/blocks/{block_id}/children', rows: '`results` array', label: 'Page content (blocks)', params: 'page_size, start_cursor' },
    { path: '/v1/comments', rows: '`results` array', label: 'Comments on a page or block', params: 'block_id (required), page_size, start_cursor' },
    { path: '/v1/users', rows: '`results` array', label: 'Workspace users', params: 'page_size, start_cursor' },
  ],

  notes: [
    'IDs are the 32-character hex string at the end of a Notion URL (dashes optional).',
    'An integration only sees pages and databases shared with it; a 404 usually means "not shared", not "missing".',
    'Rate limit is about 3 requests per second; on 429 wait for Retry-After.',
  ],
};
