/**
 * Square API preset (production or sandbox).
 *
 * Facts cross-checked against Square's API reference and the Airbyte
 * source-square manifest (connect.squareup.com / squareupsandbox host, Bearer
 * access token, cursor paging, payments/orders/customers/catalog/inventory/
 * team/shifts streams). n8n has no Square node. Only facts about the vendor's
 * API are recorded here.
 */

module.exports = {
  id: 'square',
  title: 'Square',
  description: 'Payments, orders, refunds, customers, catalog items and categories, inventory counts, locations, team members and shifts.',
  docsUrl: 'https://developer.squareup.com/reference/square',
  baseUrl: null,
  baseUrlPlaceholder: 'https://connect.squareup.com/v2',
  baseUrlHelp: 'https://connect.squareup.com/v2 for your live account, https://connect.squareupsandbox.com/v2 for a sandbox.',

  credentials: [
    { key: 'Access token', label: 'Access token', placeholder: 'EAAA…', helpText: 'developer.squareup.com → Applications → your app → Credentials → Production (or Sandbox) access token.' },
  ],

  headers: { Authorization: 'Bearer {Access token}', 'Content-Type': 'application/json' },

  test: { path: '/locations', identityField: 'locations.0.name' },

  pagination: 'While response.data.cursor is set, request again with cursor=<it> (in the query for GET, in the body for search/POST endpoints).',

  endpoints: [
    { path: '/payments', rows: '`payments` array', label: 'Payments', params: 'begin_time=<RFC3339>, end_time, location_id, limit (≤ 100), cursor, sort_order=DESC' },
    { method: 'POST', path: '/orders/search', rows: '`orders` array', label: 'Orders (with line items)',
      params: 'body: { location_ids: ["…"], query: { filter: { date_time_filter: { updated_at: { start_at, end_at } }, state_filter: { states: ["COMPLETED"] } }, sort: { sort_field: "UPDATED_AT" } }, limit (≤ 1000), cursor }' },
    { path: '/refunds', rows: '`refunds` array', label: 'Refunds', params: 'begin_time, end_time, location_id, cursor' },
    { path: '/customers', rows: '`customers` array', label: 'Customers', params: 'limit (≤ 100), cursor, sort_field=CREATED_AT' },
    { path: '/catalog/list', rows: '`objects` array', label: 'Catalog (items, variations, categories, taxes, discounts)', params: 'types=ITEM,ITEM_VARIATION,CATEGORY, cursor' },
    { method: 'POST', path: '/inventory/counts/batch-retrieve', rows: '`counts` array', label: 'Inventory counts', params: 'body: { location_ids?, catalog_object_ids?, updated_after?, cursor }' },
    { path: '/locations', rows: '`locations` array', label: 'Locations' },
    { method: 'POST', path: '/team-members/search', rows: '`team_members` array', label: 'Team members', params: 'body: { query: { filter: { status: "ACTIVE" } }, limit, cursor }' },
    { method: 'POST', path: '/labor/shifts/search', rows: '`shifts` array', label: 'Shifts (hours worked)', params: 'body: { query: { filter: { start: { start_at, end_at } } }, limit, cursor }' },
  ],

  notes: [
    'Money is { amount, currency } with amount in the smallest unit (cents).',
    'Catalog objects nest their data by type (item_data, item_variation_data) — flatten those.',
    'Send header Square-Version: YYYY-MM-DD only if you need a specific API version; otherwise the app\'s default version applies.',
  ],

  writes: {
    endpoints: [
      { method: 'POST', path: '/customers/bulk-create', label: 'Create customers', batch: 100, upsert: null,
        body: '{ customers: { "<idempotency key per row>": { given_name, family_name, email_address, phone_number?, reference_id? } } }',
        notes: 'Use a stable idempotency key per row (e.g. the email) so a retried batch is not duplicated.' },
      { method: 'POST', path: '/customers/bulk-update', label: 'Update customers by id', batch: 100, upsert: 'customer id', body: '{ customers: { "<customer id>": { email_address?, note?, … } } }' },
      { method: 'POST', path: '/customers/search', label: 'Find customers by email first', batch: 1, upsert: null, body: '{ query: { filter: { email_address: { exact: "a@b.com" } } } }' },
      { method: 'POST', path: '/catalog/batch-upsert', label: 'Create or update catalog items', batch: 1000, upsert: 'object id (use #temp ids to create)',
        body: '{ idempotency_key, batches: [{ objects: [{ type: "ITEM", id: "#tmp1", item_data: { name, variations: [ … ] } }] }] }' },
    ],
    notes: ['Responses carry an errors array per failed object.'],
  },
};
