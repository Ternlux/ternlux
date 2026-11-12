/**
 * Smartsheet API preset.
 *
 * Facts cross-checked against Smartsheet's API 2.0 docs and the Airbyte
 * source-smartsheets docs (one stream per sheet with a dynamic schema, row and
 * sheet metadata fields). n8n has no Smartsheet node. Only facts about the
 * vendor's API are recorded here.
 */

module.exports = {
  id: 'smartsheet',
  title: 'Smartsheet',
  description: 'Sheets (rows and columns), reports, workspaces, folders, users and search; add and update rows.',
  docsUrl: 'https://smartsheet.redoc.ly/',
  baseUrl: null,
  baseUrlPlaceholder: 'https://api.smartsheet.com/2.0',
  baseUrlHelp: 'https://api.smartsheet.com/2.0, or https://api.smartsheet.eu/2.0 for an EU account.',

  credentials: [
    { key: 'Access token', label: 'API access token', placeholder: 'Smartsheet token', helpText: 'Smartsheet → Account → Personal Settings → API Access → Generate new access token.' },
  ],

  headers: { Authorization: 'Bearer {Access token}', Accept: 'application/json' },

  test: { path: '/users/me', identityField: 'email' },

  pagination: 'Lists take page and pageSize (or includeAll=true for everything); read response.data.totalPages. '
    + 'GET /sheets/{id} returns every row unless you send page / pageSize.',

  endpoints: [
    { path: '/sheets', rows: '`data` array', label: 'Sheets you can see (find the sheet id)', params: 'includeAll=true, modifiedSince=<ISO>' },
    { path: '/sheets/{sheet_id}', rows: '`rows` array — map each row.cells[i] { columnId, value, displayValue } to a column title using response.data.columns',
      label: 'A sheet\'s rows and columns', params: 'include=objectValue, rowsModifiedSince=<ISO>, page, pageSize, columnIds' },
    { path: '/reports', rows: '`data` array', label: 'Reports' },
    { path: '/reports/{report_id}', rows: '`rows` array (cells map via response.data.columns virtualId)', label: 'A report\'s rows', params: 'page, pageSize' },
    { path: '/workspaces', rows: '`data` array', label: 'Workspaces' },
    { path: '/search', rows: '`results` array', label: 'Search across sheets', params: 'query=<text>, scopes=cellData' },
    { path: '/users', rows: '`data` array', label: 'Users (admins only)' },
  ],

  notes: [
    'Cells are keyed by numeric columnId, not title — always map through the sheet\'s columns. Use displayValue for formatted text, value for raw.',
    'Rate limit: 300 requests a minute per token; on 429 back off.',
  ],

  writes: {
    endpoints: [
      { method: 'POST', path: '/sheets/{sheet_id}/rows', label: 'Add rows', batch: 500, upsert: null,
        body: '[{ toBottom: true, cells: [{ columnId: <id>, value: "…" }, …] }, …]', notes: 'Get column ids from GET /sheets/{sheet_id} (columns).' },
      { method: 'PUT', path: '/sheets/{sheet_id}/rows', label: 'Update rows by row id', batch: 500, upsert: 'row id', body: '[{ id: <row id>, cells: [{ columnId, value }] }, …]' },
    ],
    notes: [
      'No upsert: read the sheet once in state (first batch), index rows by a key column\'s value, then PUT matches and POST the rest.',
      'Partial success: send query allowPartialSuccess=true and read response.data.failedItems for per-row errors.',
    ],
  },
};
