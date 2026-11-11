/**
 * ActiveCampaign API preset.
 *
 * Facts cross-checked against ActiveCampaign's API v3 docs, the Airbyte
 * source-activecampaign manifest (https://<account>.api-us1.com/api/3,
 * Api-Token header, limit/offset paging) and the n8n ActiveCampaign node
 * (contact, deal, list, tag, ecommerce resources; contact sync). Only facts
 * about the vendor's API are recorded here.
 */

module.exports = {
  id: 'activecampaign',
  title: 'ActiveCampaign',
  description: 'Contacts, lists, tags, campaigns, automations, deals, accounts and custom fields.',
  docsUrl: 'https://developers.activecampaign.com/reference/overview',
  baseUrl: null,
  baseUrlPlaceholder: 'https://youraccount.api-us1.com/api/3',
  baseUrlHelp: 'ActiveCampaign → Settings → Developer → URL, with /api/3 on the end.',

  credentials: [
    { key: 'API key', label: 'API key', placeholder: 'Your API key', helpText: 'ActiveCampaign → Settings → Developer → Key.' },
  ],

  headers: { 'Api-Token': '{API key}', Accept: 'application/json' },

  test: { path: '/users/me', identityField: 'user.email' },

  pagination: 'Send limit (≤ 100) and offset; request again with offset += limit while offset < Number(response.data.meta.total).',

  endpoints: [
    { path: '/contacts', rows: '`contacts` array', label: 'Contacts', params: 'limit, offset, email, listid, tagid, filters[updated_after]=YYYY-MM-DD, orders[cdate]=DESC' },
    { path: '/lists', rows: '`lists` array', label: 'Lists' },
    { path: '/tags', rows: '`tags` array', label: 'Tags' },
    { path: '/campaigns', rows: '`campaigns` array', label: 'Campaigns (sends, opens, clicks, unsubscribes)', params: 'limit, offset, orders[sdate]=DESC' },
    { path: '/automations', rows: '`automations` array', label: 'Automations' },
    { path: '/deals', rows: '`deals` array', label: 'Deals', params: 'limit, offset, filters[stage], filters[status]=0|1|2, filters[updated_after]' },
    { path: '/dealStages', rows: '`dealStages` array', label: 'Deal stages' },
    { path: '/accounts', rows: '`accounts` array', label: 'Accounts (companies)' },
    { path: '/fields', rows: '`fields` array', label: 'Contact custom field definitions' },
    { path: '/contacts/{id}/fieldValues', rows: '`fieldValues` array', label: 'One contact\'s custom field values' },
  ],

  notes: [
    'Most numbers and ids come back as strings; deal value is in cents.',
    'Related objects are side-loaded by id (contact.orgid, deal.contact); ask for include=… or fetch them separately.',
    'Rate limit: 5 requests a second per account.',
  ],

  writes: {
    endpoints: [
      { method: 'POST', path: '/contact/sync', label: 'Create or update a contact by email', batch: 1, upsert: 'email',
        body: '{ contact: { email, firstName?, lastName?, phone?, fieldValues?: [{ field: "<field id>", value }] } }' },
      { method: 'POST', path: '/import/bulk_import', label: 'Bulk import contacts (create or update)', batch: 250, upsert: 'email',
        body: '{ contacts: [{ email, first_name, last_name, phone?, tags?: ["…"], fields?: [{ id, value }], subscribe?: [{ listid }] }] }',
        notes: 'Asynchronous; the response has a batchId. Up to 250 contacts per call.' },
      { method: 'POST', path: '/contactLists', label: 'Subscribe a contact to a list', batch: 1, upsert: null, body: '{ contactList: { list: <list id>, contact: <contact id>, status: 1 } }' },
      { method: 'POST', path: '/contactTags', label: 'Tag a contact', batch: 1, upsert: null, body: '{ contactTag: { contact, tag } }' },
      { method: 'POST', path: '/deals', label: 'Create a deal', batch: 1, upsert: null, body: '{ deal: { title, value (cents), currency: "usd", contact, group (pipeline), stage, owner } }' },
    ],
    notes: ['Prefer /contact/sync (one contact) or /import/bulk_import (many) — both match on email, so re-runs update.'],
  },
};
