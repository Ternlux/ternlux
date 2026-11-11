/**
 * Zoho CRM connector — every module (Leads, Contacts, Accounts, Deals,
 * custom modules) read by record list or COQL, and created, updated or
 * upserted. Signs in with the user's own Zoho API Console client.
 *
 * Zoho is split into data centres: the sign-in and the API host depend on
 * where the account lives; the token response names the API domain.
 *
 * API facts cross-checked against Zoho CRM API v7 docs, the Airbyte
 * source-zoho-crm docs (modules discovered via the Modules and Fields APIs,
 * data-centre domains) and the n8n Zoho CRM node (upsert with
 * duplicate_check_fields). No code from either project.
 */

const DC = { us: 'com', eu: 'eu', in: 'in', au: 'com.au', jp: 'jp', ca: 'ca', cn: 'com.cn', sa: 'sa' };
// Canada signs in at zohocloud.ca; every other centre at accounts.zoho.<tld>.
const accounts = (c) => (c.dataCenter === 'ca' ? 'https://accounts.zohocloud.ca' : `https://accounts.zoho.${DC[c.dataCenter] || 'com'}`);
const apiDomain = (c) => String(c.apiDomain || `https://www.zohoapis.${DC[c.dataCenter] || 'com'}`).replace(/\/+$/, '');

const MAX_FIELDS = 200;

async function getLiveContext(config, { request, mode, axios }) {
  const base = config.baseUrl;
  const { data } = await axios.get(`${base}/settings/modules`);
  const mods = (data.modules || []).filter((m) => m.api_supported);
  const lines = [`Zoho CRM modules (api_name → label): ${mods.map((m) => `${m.api_name} → ${m.plural_label}`).join('; ')}.`];
  const text = String(request || '').toLowerCase();
  const focus = mods.filter((m) => [m.api_name, m.plural_label, m.singular_label].some((n) => n && text.includes(String(n).toLowerCase()))).slice(0, 4);
  for (const m of focus) {
    // eslint-disable-next-line no-await-in-loop
    const { data: f } = await axios.get(`${base}/settings/fields`, { params: { module: m.api_name } });
    lines.push('', `${m.api_name} fields right now:`);
    for (const x of (f.fields || []).slice(0, MAX_FIELDS)) {
      const bits = [x.data_type];
      if (x.custom_field) bits.push('custom');
      if (mode === 'write' && x.system_mandatory) bits.push('required');
      if (mode === 'write' && x.read_only) bits.push('read-only');
      if (x.unique?.casesensitive !== undefined || x.unique === true) bits.push('unique');
      if (Array.isArray(x.pick_list_values) && x.pick_list_values.length) bits.push(`values: ${x.pick_list_values.slice(0, 15).map((p) => p.display_value).join(' | ')}`);
      lines.push(`  - ${x.api_name} (${x.field_label}): ${bits.join(', ')}`);
    }
  }
  return lines.join('\n');
}

module.exports = {
  type: 'connector',
  id: 'zoho-crm',
  name: 'Zoho CRM',
  dbCategory: 'API',

  oauth: {
    authorizeUrl: (c) => `${accounts(c)}/oauth/v2/auth`,
    tokenUrl: (c) => `${accounts(c)}/oauth/v2/token`,
    scopes: ['ZohoCRM.modules.ALL', 'ZohoCRM.settings.READ', 'ZohoCRM.coql.READ', 'ZohoCRM.users.READ', 'ZohoCRM.org.READ'],
    scopeSeparator: ',',
    authParams: { access_type: 'offline', prompt: 'consent' },
    clientIdHelp: 'api-console.zoho.com → your Server-based Application → Client ID (use the console of your data centre).',
    parseTokens: (data) => ({
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresIn: data.expires_in,
      extra: data.api_domain ? { apiDomain: data.api_domain } : {},
    }),
  },

  apiBaseUrl: (config) => `${apiDomain(config)}/crm/v7`,

  apiReference: {
    title: 'Zoho CRM API v7',
    docsUrl: 'https://www.zoho.com/crm/developer/docs/api/v7/',
    baseUrl: null,
    baseUrlPlaceholder: 'https://www.zohoapis.com/crm/v7',
    // Zoho's own scheme, not "Bearer".
    headers: { Authorization: 'Zoho-oauthtoken {accessToken}' },
    test: { path: '/org', identity: (d) => d.org?.[0]?.company_name },
    pagination: 'Record lists: per_page (≤ 200) and page; read response.data.info.more_records — past 2,000 records continue with '
      + 'page_token=<info.next_page_token> instead of page. COQL: LIMIT up to 2000 with OFFSET, up to 100,000 rows in all.',
    endpoints: [
      { method: 'GET', path: '/{module}', label: 'Records of a module', rows: '`data` array (a 204 No Content means no records)',
        params: 'fields=Last_Name,Email,Owner (required, ≤ 50 fields), per_page, page | page_token, sort_by=Modified_Time, sort_order=desc, cvid (custom view)' },
      { method: 'POST', path: '/coql', label: 'COQL query (filters, joins on lookups, aggregates)', rows: '`data` array',
        params: "body: { select_query: \"select Last_Name, Email, Account_Name.Account_Name from Contacts where Modified_Time > '2025-01-01T00:00:00+00:00' limit 2000 offset 0\" }",
        notes: 'Every COQL query needs a WHERE clause (use id is not null for all). Datetimes need an offset.' },
      { method: 'GET', path: '/{module}/search', label: 'Search records', rows: '`data` array', params: 'criteria=((Email:equals:a@b.com)) | email=… | phone=… | word=…' },
      { method: 'GET', path: '/settings/modules', label: 'Every module (find api_name)', rows: '`modules` array' },
      { method: 'GET', path: '/settings/fields', label: 'A module\'s fields', rows: '`fields` array (api_name, data_type, pick_list_values)', params: 'module=<api_name>' },
      { method: 'GET', path: '/users', label: 'Users', rows: '`users` array', params: 'type=ActiveUsers' },
    ],
    notes: [
      'Module and field names are api_names: Leads, Contacts, Accounts, Deals, Tasks, custom ones; fields like Last_Name, Account_Name, Closing_Date.',
      'Lookups come back as objects { id, name }; flatten to two columns.',
      'Each API call costs credits (per day, per edition); prefer COQL or 200-record pages over one call per record.',
    ],
    writes: {
      endpoints: [
        { method: 'POST', path: '/{module}/upsert', label: 'Upsert records (match on unique fields)', batch: 100, upsert: 'duplicate_check_fields',
          body: '{ data: [{ Last_Name, Email, Company, … }], duplicate_check_fields: ["Email"] }',
          notes: 'Response data[i] = { code: "SUCCESS", action: "insert"|"update", details: { id } } or an error code per record.' },
        { method: 'POST', path: '/{module}', label: 'Create records', batch: 100, upsert: null, body: '{ data: [{ …fields }], trigger?: ["workflow"] }' },
        { method: 'PUT', path: '/{module}', label: 'Update records by id', batch: 100, upsert: 'id', body: '{ data: [{ id: "<record id>", …fields to change }] }' },
      ],
      notes: [
        'Mandatory fields: Leads and Contacts need Last_Name; Deals need Deal_Name and Stage; Accounts need Account_Name.',
        'Lookups take { id }: Account_Name: { id: "…" }. Picklists accept their display values.',
        'A record-level error does not fail the call — read each data[i].code and report the non-SUCCESS ones as failed.',
      ],
    },
  },

  getLiveContext,

  configSchema: {
    fields: [
      { name: 'dataCenter', type: 'select', label: 'Data centre', required: true, sensitive: false, default: 'us',
        options: [
          { label: 'United States (zoho.com)', value: 'us' }, { label: 'Europe (zoho.eu)', value: 'eu' },
          { label: 'India (zoho.in)', value: 'in' }, { label: 'Australia (zoho.com.au)', value: 'au' },
          { label: 'Japan (zoho.jp)', value: 'jp' }, { label: 'Canada (zohocloud.ca)', value: 'ca' },
          { label: 'China (zoho.com.cn)', value: 'cn' }, { label: 'Saudi Arabia (zoho.sa)', value: 'sa' },
        ],
        helpText: 'Where your Zoho account lives — the domain you sign in at.' },
      { name: 'apiDomain', type: 'hidden', label: 'API domain', required: false, sensitive: false },
    ],
  },

  metadata: {
    displayName: 'Zoho CRM',
    description: 'Every module by record list or COQL; create, update and upsert records',
    version: '1.0.0',
  },
};
