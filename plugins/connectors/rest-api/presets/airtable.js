/**
 * Airtable API preset.
 *
 * Endpoint and field facts cross-checked against the vendor's public API docs,
 * the Airbyte source connector and the n8n node / credential for it. Only facts
 * about the vendor's API are recorded here; no code from either project.
 */

module.exports = {
  id: 'airtable',
  title: 'Airtable',
  description: 'Bases, tables and records.',
  docsUrl: 'https://airtable.com/developers/web/api/introduction',
  baseUrl: 'https://api.airtable.com',

  credentials: [
    {
      key: 'Personal access token',
      label: 'Personal access token',
      placeholder: 'pat…',
      helpText: 'airtable.com/create/tokens → Create token with scopes data.records:read and '
        + 'schema.bases:read, and give it access to the bases you want.',
    },
  ],

  headers: {
    Authorization: 'Bearer {Personal access token}',
  },

  test: { path: '/v0/meta/whoami', identityField: 'email' },

  pagination: 'Record lists return up to 100 rows (pageSize) and an `offset` while more remain — send '
    + 'offset=<response.data.offset> on the next request; stop when offset is missing. '
    + 'Base lists page the same way with offset.',

  endpoints: [
    { path: '/v0/meta/bases', rows: '`bases` array', label: 'Bases the token can see', params: 'offset' },
    { path: '/v0/meta/bases/{baseId}/tables', rows: '`tables` array', label: 'Tables and fields of a base' },
    { path: '/v0/{baseId}/{tableIdOrName}', rows: '`records` array', label: 'Records of a table', params: 'pageSize (max 100), offset, view, fields[]=<name>, filterByFormula, sort[0][field], sort[0][direction]', notes: 'Each record is { id, createdTime, fields: {...} } — flatten fields into columns. Empty cells are left out of fields entirely.' },
    { path: '/v0/{baseId}/{tableIdOrName}/{recordId}', rows: 'single object', label: 'One record' },
  ],

  notes: [
    'baseId starts with "app", table ids with "tbl"; both appear in the Airtable URL. A table name works in place of its id (URL-encode it).',
    'Rate limit: 5 requests per second per base; on 429 wait 30 seconds.',
  ],
};
