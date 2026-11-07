/**
 * HubSpot CRM API preset.
 *
 * Endpoint and field facts cross-checked against the public HubSpot developer
 * docs, the Airbyte `source-hubspot` connector and the n8n HubSpot node. Only
 * facts about HubSpot's API are recorded here; no code from either project.
 * The v3 CRM endpoints are used throughout — the v1/v2 ones are legacy.
 */

module.exports = {
  id: 'hubspot',
  title: 'HubSpot',
  description: 'Contacts, companies, deals, tickets, owners, pipelines and forms.',
  docsUrl: 'https://developers.hubspot.com/docs/api/crm/understanding-the-crm',
  baseUrl: 'https://api.hubapi.com',

  // Service keys replace legacy private apps (HubSpot stopped creating those
  // on 2026-10-26). Both are sent the same way, as a Bearer token, so an
  // existing private app token works in this field too.
  credentials: [
    {
      key: 'Access token',
      label: 'Service key',
      placeholder: 'Paste the service key',
      helpText: 'HubSpot → Settings → Integrations → Service Keys (or Development → Keys → Service Keys) '
        + '→ Create a service key, add the read scopes you need, and copy the key. Suggested scopes: '
        + 'crm.objects.contacts.read, crm.objects.companies.read, crm.objects.deals.read, tickets, '
        + 'crm.objects.owners.read, forms. An existing legacy private app token also works here.',
    },
  ],

  headers: {
    Authorization: 'Bearer {Access token}',
    Accept: 'application/json',
  },

  // The contacts read scope is the one nearly every HubSpot pull needs.
  test: { path: '/crm/v3/objects/contacts?limit=1' },

  pagination: 'Cursor paging. Send limit (max 100) and, after the first page, after=<value>. '
    + 'The next cursor is response.data.paging.next.after; stop when `paging` is missing. '
    + 'For POST …/search the cursor goes in the JSON body as "after", not the query string.',

  endpoints: [
    { path: '/crm/v3/objects/contacts', rows: '`results` array', label: 'Contacts', params: 'limit, after, properties=comma,separated,names, archived=false, associations=companies,deals' },
    { path: '/crm/v3/objects/companies', rows: '`results` array', label: 'Companies', params: 'limit, after, properties, archived, associations' },
    { path: '/crm/v3/objects/deals', rows: '`results` array', label: 'Deals', params: 'limit, after, properties (e.g. dealname,amount,dealstage,closedate,pipeline), archived, associations' },
    { path: '/crm/v3/objects/tickets', rows: '`results` array', label: 'Tickets', params: 'limit, after, properties, archived, associations' },
    { path: '/crm/v3/objects/{calls|emails|meetings|notes|tasks|line_items|products}', rows: '`results` array', label: 'Engagements and other CRM objects', notes: 'Same shape and paging as contacts.' },
    { method: 'POST', path: '/crm/v3/objects/{object}/search', rows: '`results` array', label: 'Filtered or "changed since" pulls', params: 'JSON body: { filterGroups: [{ filters: [{ propertyName, operator: EQ|NEQ|GT|GTE|LT|LTE|BETWEEN|IN|HAS_PROPERTY|CONTAINS_TOKEN, value }] }], sorts, properties, limit, after }', notes: 'Use hs_lastmodifieddate (lastmodifieddate for contacts) with GTE and a millisecond epoch for incremental pulls. A single search stops at 10,000 results — split long ranges into smaller date windows.' },
    { path: '/crm/v3/properties/{object}', rows: '`results` array', label: 'Property definitions for an object', notes: 'Use `name` from each row in the `properties` parameter.' },
    { path: '/crm/v3/owners', rows: '`results` array', label: 'Owners (users records are assigned to)', params: 'limit, after, email' },
    { path: '/crm/v3/pipelines/{deals|tickets}', rows: '`results` array', label: 'Pipelines and their stages', notes: 'Stages are nested under each pipeline’s `stages`. Not paginated.' },
    { path: '/marketing/v3/forms', rows: '`results` array', label: 'Forms', params: 'limit, after' },
    { path: '/settings/v3/users', rows: '`results` array', label: 'Account users', params: 'limit, after' },
  ],

  notes: [
    'Object reads return only a few default properties unless `properties` lists the ones wanted. '
      + 'If the user asks for "all fields", read /crm/v3/properties/{object} first and pass the names.',
    'Each row nests its fields under `properties` (e.g. row.properties.email); flatten them into top-level columns and keep id, createdAt, updatedAt and archived alongside.',
    'Dates inside `properties` are ISO-8601 strings; search filters on dates take millisecond epoch values.',
    'On 429, wait for the `Retry-After` header before retrying. 403 usually means the key is missing a scope.',
  ],
};
