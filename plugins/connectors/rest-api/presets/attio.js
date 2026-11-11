/**
 * Attio API preset.
 *
 * Facts from Attio's REST API v2 docs. Neither Airbyte's main catalog nor n8n
 * has an Attio source, so endpoints and the assert (upsert) behaviour were
 * checked against Attio's reference only. Only facts about the vendor's API
 * are recorded here.
 */

module.exports = {
  id: 'attio',
  title: 'Attio',
  description: 'Records of any object (people, companies, deals, custom objects), lists and entries, notes, tasks and members.',
  docsUrl: 'https://docs.attio.com/rest-api/overview',
  baseUrl: 'https://api.attio.com/v2',

  credentials: [
    { key: 'Access token', label: 'API access token', placeholder: 'Bearer token', helpText: 'Attio → Workspace settings → Developers → New access token; give it read (and write, to send rows) access to records and lists.' },
  ],

  headers: { Authorization: 'Bearer {Access token}', 'Content-Type': 'application/json' },

  test: { path: '/self', identityField: 'workspace_name' },

  pagination: 'Query endpoints take limit (≤ 500) and offset in the body; request again with offset += limit while a full page came back.',

  endpoints: [
    { method: 'POST', path: '/objects/{object}/records/query', rows: '`data` array — values under data[i].values.<attribute>[0]', label: 'Records of an object (people, companies, deals, custom)',
      params: 'body: { filter?: { email_addresses: "a@b.com" } or { "$and": [...] }, sorts?: [{ attribute: "created_at", direction: "desc" }], limit, offset }',
      notes: 'Every attribute value is an array of value objects; read the first one\'s value / full_name / email_address / domain / target_record_id.' },
    { path: '/objects', rows: '`data` array', label: 'Objects in the workspace (find api_slug)' },
    { path: '/objects/{object}/attributes', rows: '`data` array', label: 'An object\'s attributes and their types' },
    { path: '/lists', rows: '`data` array', label: 'Lists (pipelines)' },
    { method: 'POST', path: '/lists/{list}/entries/query', rows: '`data` array', label: 'Entries of a list (with entry values such as stage)', params: 'body: { filter?, sorts?, limit, offset }' },
    { path: '/notes', rows: '`data` array', label: 'Notes', params: 'parent_object, parent_record_id, limit, offset' },
    { path: '/tasks', rows: '`data` array', label: 'Tasks', params: 'limit, offset, is_completed' },
    { path: '/workspace_members', rows: '`data` array', label: 'Workspace members' },
  ],

  notes: [
    'Standard objects: people, companies, deals, users, workspaces; custom ones by their api_slug (see /objects).',
    'Record ids are data[i].id.record_id.',
    'Rate limit: about 100 reads and 25 writes a second; on 429 honour Retry-After.',
  ],

  writes: {
    endpoints: [
      { method: 'PUT', path: '/objects/{object}/records?matching_attribute={attribute}', label: 'Assert a record — create or update on a unique attribute', batch: 1,
        upsert: 'matching_attribute (email_addresses for people, domains for companies)',
        body: '{ data: { values: { email_addresses: ["a@b.com"], name: [{ first_name, last_name, full_name }], job_title: "…" } } }' },
      { method: 'POST', path: '/objects/{object}/records', label: 'Create a record', batch: 1, upsert: null, body: '{ data: { values: { … } } }' },
      { method: 'PATCH', path: '/objects/{object}/records/{record_id}', label: 'Update a record (append to multi-value attributes)', batch: 1, upsert: 'record_id', body: '{ data: { values: { … } } }' },
      { method: 'POST', path: '/lists/{list}/entries', label: 'Add a record to a list', batch: 1, upsert: null, body: '{ data: { parent_record_id, parent_object, entry_values: { stage: "…" } } }' },
    ],
    notes: ['Prefer the assert (PUT) endpoint so re-runs update instead of duplicating. A companies record links to people through the team attribute.'],
  },
};
