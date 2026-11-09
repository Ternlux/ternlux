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

  writes: {
    endpoints: [
      { method: 'PATCH', path: '/v0/{baseId}/{tableIdOrName}', label: 'Create or update records by matching fields', batch: 10, upsert: 'fieldsToMergeOn',
        body: '{ performUpsert: { fieldsToMergeOn: ["<field>"] }, records: [{ fields: { … } }], typecast: true }',
        notes: 'A record whose merge fields match is updated, others are created.' },
      { method: 'POST', path: '/v0/{baseId}/{tableIdOrName}', label: 'Create records', batch: 10, upsert: null,
        body: '{ records: [{ fields: { … } }], typecast: true }' },
    ],
    notes: [
      'At most 10 records per request and 5 requests per second per base — pause ~250 ms between requests.',
      'Field names are the column names exactly as shown in Airtable. typecast: true lets text match select options and creates missing ones.',
      'A linked-record field takes an array of record ids (rec…), not names. Dates as YYYY-MM-DD or ISO-8601.',
      'Needs the data.records:write scope and Editor access to the base.',
      'A base named by the user is found by GET /v0/meta/bases (bases[].name → id); a table can be addressed by its name (URL-encoded).',
    ],
  },
};
