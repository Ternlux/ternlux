/**
 * Close CRM API preset.
 *
 * Facts cross-checked against Close's API docs and the Airbyte source-close-com
 * manifest (https://api.close.com/api/v1/, HTTP Basic with the API key as the
 * username, _skip/_limit paging, activity and task streams). n8n has no Close
 * node. Only facts about the vendor's API are recorded here.
 */

module.exports = {
  id: 'close',
  title: 'Close',
  description: 'Leads, contacts, opportunities, activities (calls, emails, SMS, notes, meetings), tasks and pipelines.',
  docsUrl: 'https://developer.close.com/',
  baseUrl: 'https://api.close.com/api/v1',

  credentials: [
    { key: 'API key', label: 'API key', placeholder: 'api_…', helpText: 'Close → Settings → Developer → API Keys → + New API Key.' },
  ],

  // Close uses HTTP Basic with the key as the username and no password.
  basicAuth: { username: '{API key}', password: '' },
  headers: { Accept: 'application/json' },

  test: { path: '/me/', identityField: 'email' },

  pagination: 'Send _limit (≤ 100; 200 for some lists) and _skip; request again with _skip += _limit while response.data.has_more is true. '
    + 'Use _fields=id,display_name,… to keep responses small.',

  endpoints: [
    { path: '/lead/', rows: '`data` array', label: 'Leads (companies, with their contacts and custom fields)', params: '_limit, _skip, query=<Close search syntax, e.g. "updated > 2025-01-01">, _fields' },
    { path: '/contact/', rows: '`data` array', label: 'Contacts', params: '_limit, _skip, lead_id' },
    { path: '/opportunity/', rows: '`data` array', label: 'Opportunities', params: '_limit, _skip, status_type=active|won|lost, date_updated__gte, lead_id' },
    { path: '/activity/', rows: '`data` array', label: 'Every activity (filter by type)', params: '_limit, _skip, _type=Call|Email|EmailThread|SMS|Note|Meeting|LeadStatusChange|OpportunityStatusChange, date_created__gte, lead_id' },
    { path: '/activity/call/', rows: '`data` array', label: 'Calls (duration, direction, disposition)', params: '_limit, _skip, date_created__gte' },
    { path: '/activity/email/', rows: '`data` array', label: 'Emails', params: '_limit, _skip, date_created__gte' },
    { path: '/task/', rows: '`data` array', label: 'Tasks', params: '_limit, _skip, is_complete, assigned_to, date__gte' },
    { path: '/user/', rows: '`data` array', label: 'Users' },
    { path: '/status/lead/', rows: '`data` array', label: 'Lead statuses' },
    { path: '/pipeline/', rows: '`data` array', label: 'Opportunity pipelines and their statuses' },
    { path: '/custom_field/lead/', rows: '`data` array', label: 'Lead custom field definitions (names for custom.cf_… keys)' },
  ],

  notes: [
    'Money (opportunity value) is in cents; value_period is one_time | monthly | annual.',
    'Custom fields appear as "custom.cf_<id>" keys; map them to names with /custom_field/lead/ (or /contact/, /opportunity/).',
    'Rate limits are per endpoint group; on 429 wait for the rate_reset seconds in the response.',
  ],

  writes: {
    endpoints: [
      { method: 'POST', path: '/lead/', label: 'Create a lead (with contacts)', batch: 1, upsert: null,
        body: '{ name, url?, status_id?, contacts?: [{ name, emails: [{ email, type: "office" }], phones?: [{ phone, type }] }], "custom.cf_…"? }' },
      { method: 'PUT', path: '/lead/{id}/', label: 'Update a lead', batch: 1, upsert: 'id', body: '{ …fields to change }' },
      { method: 'POST', path: '/contact/', label: 'Create a contact on a lead', batch: 1, upsert: null, body: '{ lead_id, name, title?, emails: [{ email, type }] }' },
      { method: 'PUT', path: '/contact/{id}/', label: 'Update a contact', batch: 1, upsert: 'id', body: '{ …fields }' },
      { method: 'POST', path: '/opportunity/', label: 'Create an opportunity', batch: 1, upsert: null, body: '{ lead_id, status_id, value (cents), value_period, confidence?, note? }' },
      { method: 'GET', path: '/lead/?query=email_address:"{email}"', label: 'Find a lead by a contact email first', batch: 1, upsert: null, body: '—' },
    ],
    notes: ['No upsert: search (query=email_address:"…" or name:"…") and PUT the match, else POST.'],
  },
};
