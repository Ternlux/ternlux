/**
 * Pipedrive API preset.
 *
 * Endpoint and field facts cross-checked against the vendor's public API docs,
 * the Airbyte source connector and the n8n node / credential for it. Only facts
 * about the vendor's API are recorded here; no code from either project.
 * The token goes in the x-api-token header (Airbyte), not the api_token query
 * parameter (n8n), so it never appears in a URL.
 */

module.exports = {
  id: 'pipedrive',
  title: 'Pipedrive',
  description: 'Deals, persons, organizations, activities, leads, products and pipelines.',
  docsUrl: 'https://developers.pipedrive.com/docs/api/v1',
  baseUrl: 'https://api.pipedrive.com',

  credentials: [
    {
      key: 'API token',
      label: 'Personal API token',
      placeholder: '40-character token',
      helpText: 'Pipedrive → your avatar → Personal preferences → API → copy your personal API token.',
    },
  ],

  headers: {
    'x-api-token': '{API token}',
    Accept: 'application/json',
  },

  test: { path: '/v1/users/me', identityField: 'data.name' },

  pagination: 'v2 endpoints (/api/v2/…): send limit (max 500); while response.data.additional_data.next_cursor is set, '
    + 'request again with cursor=<it>. v1 endpoints (/v1/…): send start and limit; while '
    + 'response.data.additional_data.pagination.more_items_in_collection is true, use start=<pagination.next_start>.',

  endpoints: [
    { path: '/api/v2/deals', rows: '`data` array', label: 'Deals', params: 'limit, cursor, status=open|won|lost|deleted, pipeline_id, stage_id, owner_id, updated_since=<RFC3339>, sort_by=update_time' },
    { path: '/api/v2/persons', rows: '`data` array', label: 'Persons (contacts)', params: 'limit, cursor, org_id, owner_id, updated_since' },
    { path: '/api/v2/organizations', rows: '`data` array', label: 'Organizations', params: 'limit, cursor, owner_id, updated_since' },
    { path: '/api/v2/activities', rows: '`data` array', label: 'Activities', params: 'limit, cursor, deal_id, person_id, owner_id, done, updated_since' },
    { path: '/api/v2/products', rows: '`data` array', label: 'Products', params: 'limit, cursor, owner_id' },
    { path: '/api/v2/pipelines', rows: '`data` array', label: 'Pipelines' },
    { path: '/api/v2/stages', rows: '`data` array', label: 'Stages', params: 'pipeline_id' },
    { path: '/v1/leads', rows: '`data` array', label: 'Leads', params: 'start, limit, archived_status=archived|not_archived|all' },
    { path: '/v1/notes', rows: '`data` array', label: 'Notes', params: 'start, limit, deal_id, person_id, org_id' },
    { path: '/v1/users', rows: '`data` array', label: 'Users' },
    { path: '/v1/dealFields', rows: '`data` array', label: 'Deal field definitions (names for custom field keys)', params: 'start, limit' },
  ],

  notes: [
    'Custom fields come back as 40-character hash keys; map them to names with /v1/dealFields, /v1/personFields or /v1/organizationFields.',
    'On 429, wait for the Retry-After / x-ratelimit-reset header.',
  ],
};
