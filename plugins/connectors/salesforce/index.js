/**
 * Salesforce connector.
 *
 * Signs in with the user's own External Client App (or Connected App) using
 * the OAuth web-server flow with PKCE. The token response names the org's
 * instance URL, which becomes the base of every request; the newest REST API
 * version the org serves is read once at sign-in.
 *
 * Reading: the AI writes SOQL against /query (or a Bulk API 2.0 query job for
 * large extracts). Writing: sObject Collections (up to 200 records a call),
 * with upsert on an external-id field. The live context lists the org's
 * objects and, for the objects a request names, their fields as they are now —
 * custom fields included.
 *
 * API facts cross-checked against Salesforce's REST API, Bulk API 2.0 and
 * OAuth docs, the Airbyte source-salesforce docs (incremental on
 * SystemModstamp, Bulk vs REST, refresh-token auth) and the n8n Salesforce
 * node (resources, upsert on external id). No code from either project.
 */

const DEFAULT_VERSION = '64.0';
const MAX_OBJECTS_LISTED = 250;
const MAX_FOCUS = 4;
const MAX_FIELDS = 200;

const loginBase = (config) => {
  const raw = String(config.loginUrl || 'https://login.salesforce.com').trim().replace(/\/+$/, '');
  return /^https:\/\//i.test(raw) ? raw : `https://${raw}`;
};

const apiBaseUrl = (config) => {
  const instance = String(config.instanceUrl || '').replace(/\/+$/, '');
  return instance ? `${instance}/services/data/v${config.apiVersion || DEFAULT_VERSION}` : '';
};

// "opportunities" → matches Opportunity; "Invoice__c" or "invoice" → Invoice__c
function mentionedObjects(sobjects, request) {
  const text = ` ${String(request || '').toLowerCase().replace(/[^a-z0-9_]+/g, ' ')} `;
  const hit = (word) => {
    const w = String(word || '').toLowerCase();
    if (!w || w.length < 3) return false;
    return text.includes(` ${w} `) || text.includes(` ${w}s `) || text.includes(` ${w}es `)
      || (w.endsWith('y') && text.includes(` ${w.slice(0, -1)}ies `));
  };
  return sobjects.filter((o) => hit(o.name) || hit(o.name.replace(/__c$/i, '')) || hit(o.label) || hit(o.labelPlural))
    .slice(0, MAX_FOCUS);
}

function fieldLine(f, mode) {
  const bits = [f.type];
  if (f.custom) bits.push('custom');
  if (f.externalId) bits.push('external id');
  if (f.idLookup && f.name !== 'Id') bits.push('lookup key');
  if (f.referenceTo && f.referenceTo.length) bits.push(`→ ${f.referenceTo.join('/')}${f.relationshipName ? ` (via ${f.relationshipName})` : ''}`);
  if (mode === 'write') {
    if (!f.createable && !f.updateable) bits.push('read-only');
    else if (!f.nillable && f.createable && !f.defaultedOnCreate) bits.push('required on create');
  }
  if (f.picklistValues && f.picklistValues.length) {
    const vals = f.picklistValues.filter((v) => v.active).slice(0, 15).map((v) => v.value);
    if (vals.length) bits.push(`values: ${vals.join(' | ')}`);
  }
  return `  - ${f.name} (${f.label}): ${bits.join(', ')}`;
}

async function getLiveContext(config, { request, mode, axios }) {
  const base = config.baseUrl;
  if (!base) return '';
  const { data } = await axios.get(`${base}/sobjects`);
  const all = (data.sobjects || []).filter((o) => o.queryable && !o.deprecatedAndHidden);
  const lines = [];
  const custom = all.filter((o) => o.custom);
  const standardCommon = all.filter((o) => !o.custom && /^(Account|Contact|Lead|Opportunity|OpportunityLineItem|Case|Task|Event|User|Campaign|CampaignMember|Product2|Pricebook2|PricebookEntry|Quote|Contract|Order|OrderItem|Asset|Note|ContentDocument)$/.test(o.name));
  lines.push(`Salesforce org API: ${base} (${all.length} queryable objects).`);
  lines.push(`Common standard objects: ${standardCommon.map((o) => o.name).join(', ')}.`);
  lines.push(custom.length
    ? `Custom objects (API name — label): ${custom.slice(0, MAX_OBJECTS_LISTED).map((o) => `${o.name} — ${o.label}`).join('; ')}.`
    : 'Custom objects: none.');

  const focus = mentionedObjects(all, request);
  for (const o of focus) {
    // eslint-disable-next-line no-await-in-loop
    const { data: d } = await axios.get(`${base}/sobjects/${o.name}/describe`);
    const fields = (d.fields || []).slice(0, MAX_FIELDS);
    lines.push('', `${o.name} fields right now (${(d.fields || []).length}${(d.fields || []).length > MAX_FIELDS ? `, first ${MAX_FIELDS} shown` : ''}):`);
    lines.push(...fields.map((f) => fieldLine(f, mode)));
    if (mode === 'write') {
      const ext = (d.fields || []).filter((f) => f.externalId).map((f) => f.name);
      lines.push(ext.length
        ? `  Upsert keys (external-id fields) on ${o.name}: ${ext.join(', ')}.`
        : `  ${o.name} has no external-id field, so upsert by external id is not possible; look records up with SOQL first (e.g. by Email) and update by Id.`);
    }
  }
  if (!focus.length) lines.push('', 'No object named in the request matched; ask which object, or describe one with GET /sobjects/{name}/describe in the probe.');
  return lines.join('\n');
}

module.exports = {
  type: 'connector',
  id: 'salesforce',
  name: 'Salesforce',
  dbCategory: 'API',

  oauth: {
    authorizeUrl: (config) => `${loginBase(config)}/services/oauth2/authorize`,
    tokenUrl: (config) => `${loginBase(config)}/services/oauth2/token`,
    scopes: ['api', 'refresh_token', 'offline_access'],
    pkce: true,
    clientIdLabel: 'Consumer key',
    clientIdHelp: 'Setup → External Client App Manager → your app → Settings → OAuth Settings → Consumer Key and Secret.',
    clientSecretLabel: 'Consumer secret',
    // Salesforce returns no expires_in: the token lasts the org's session
    // timeout (2 hours by default). Assume less, and the 401 retry covers a
    // shorter timeout. instance_url comes back on sign-in and on refresh.
    parseTokens: (data) => ({
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresIn: 55 * 60,
      extra: data.instance_url ? { instanceUrl: data.instance_url } : {},
    }),
    // The newest API version the org serves, once at sign-in.
    afterExchange: async (config, axios) => {
      try {
        const { data } = await axios.get(`${String(config.instanceUrl).replace(/\/+$/, '')}/services/data/`, {
          headers: { Authorization: `Bearer ${config.accessToken}` }, timeout: 15000,
        });
        const latest = (Array.isArray(data) ? data : []).map((v) => v.version).filter(Boolean)
          .sort((a, b) => Number(a) - Number(b)).pop();
        return latest ? { apiVersion: latest } : {};
      } catch (_) {
        return {};
      }
    },
  },

  apiBaseUrl,

  apiReference: {
    title: 'Salesforce REST API',
    docsUrl: 'https://developer.salesforce.com/docs/atlas.en-us.api_rest.meta/api_rest/',
    baseUrl: null,
    baseUrlPlaceholder: 'https://yourorg.my.salesforce.com/services/data/v64.0',
    headers: { Authorization: 'Bearer {accessToken}', 'Content-Type': 'application/json' },
    // nextRecordsUrl and Bulk result paths are host-relative, so the code
    // needs the bare instance URL as well as the versioned base.
    tokenFields: ['instanceUrl'],
    test: { path: '{instanceUrl}/services/oauth2/userinfo', identity: (d) => d.preferred_username || d.name || d.email },
    pagination: 'GET /query returns { totalSize, done, records, nextRecordsUrl }. While done is false, GET '
      + '`{{INSTANCE_URL}}` + nextRecordsUrl (it is a path starting /services/data/… — prefix the INSTANCE URL, never the base URL). '
      + 'Pages hold up to 2000 records.',
    endpoints: [
      { method: 'GET', path: '/query', label: 'Run a SOQL query',
        rows: '`records` array (each has an `attributes` object — drop it; relationship fields are nested objects, e.g. record.Account.Name)',
        params: 'q=<SOQL, URL-encoded>, e.g. SELECT Id, Name, Amount, StageName, CloseDate, Account.Name FROM Opportunity WHERE IsClosed = false',
        notes: 'SOQL has no SELECT * — name the fields (FIELDS(STANDARD) works with LIMIT 200 only). Dates are literal: '
          + 'CloseDate >= 2025-01-01, timestamps 2025-01-01T00:00:00Z, or date literals like LAST_N_DAYS:30.' },
      { method: 'GET', path: '/queryAll', label: 'SOQL including deleted and archived records', rows: '`records` array', params: 'q=<SOQL>' },
      { method: 'GET', path: '/sobjects', label: 'Every object in the org (find API names)', rows: '`sobjects` array (name, label, custom, queryable)' },
      { method: 'GET', path: '/sobjects/{object}/describe', label: 'An object\'s fields, types, picklist values and relationships',
        rows: '`fields` array (name, label, type, externalId, picklistValues, referenceTo)' },
      { method: 'GET', path: '/sobjects/{object}/updated', label: 'Ids of records changed in a window', rows: '`ids` array', params: 'start, end (ISO-8601 UTC, at most 30 days apart)' },
      { method: 'POST', path: '/jobs/query', label: 'Bulk API 2.0 query job (large extracts, > ~50,000 rows)',
        rows: 'none — poll GET /jobs/query/{jobId} until state is "JobComplete", then GET /jobs/query/{jobId}/results',
        params: 'body: { operation: "query" | "queryAll", query: "<SOQL>" }',
        notes: 'Results are CSV: request with responseType "text", parse with tools.parseCsv(text). While the response header '
          + 'sforce-locator is not "null", request results again with locator=<it>&maxRecords=50000. Wait with tools.sleep(5000) between polls.' },
      { method: 'GET', path: '/limits', label: 'API limits used and remaining today', rows: 'one object keyed by limit name (DailyApiRequests.Remaining …)' },
      { method: 'GET', path: '/analytics/reports/{reportId}', label: 'Run a saved report (summary of up to 2000 rows)', rows: '`factMap` — prefer SOQL for raw records' },
    ],
    notes: [
      'For an incremental read, filter on SystemModstamp > <last run time> and ORDER BY SystemModstamp.',
      'Custom objects and fields end in __c; relationship names of custom lookups end in __r (SELECT Owner__r.Name …).',
      'Ids are 18 characters in API responses; keep them as strings.',
      'Every call counts against the org\'s daily API request limit (GET /limits); one /query page of 2000 is one call.',
      'INVALID_FIELD / INVALID_TYPE errors name the bad field or object — check the live account details for the exact API names.',
    ],
    writes: {
      endpoints: [
        { method: 'POST', path: '/composite/sobjects', label: 'Create records (any object)', batch: 200, upsert: null,
          body: '{ allOrNone: false, records: [{ attributes: { type: "Contact" }, LastName, Email, AccountId? , … }] }',
          notes: 'Response is an array in record order: { id, success, errors: [{ statusCode, message, fields }] }.' },
        { method: 'PATCH', path: '/composite/sobjects/{object}/{externalIdField}', label: 'Upsert on an external-id field', batch: 200,
          upsert: 'the external-id field (or Id)',
          body: '{ allOrNone: false, records: [{ attributes: { type: "<object>" }, <externalIdField>: "<value>", …fields }] }',
          notes: 'Every record must carry the external-id field. Response items have created: true|false.' },
        { method: 'PATCH', path: '/composite/sobjects', label: 'Update records by Id', batch: 200, upsert: 'Id',
          body: '{ allOrNone: false, records: [{ attributes: { type: "<object>" }, id: "<18-char Id>", …fields to change }] }' },
        { method: 'GET', path: '/query', label: 'Look records up first (no external id: match on Email, Name…)', batch: 1, upsert: null,
          body: "q=SELECT Id, Email FROM Contact WHERE Email IN ('a@x.com','b@y.com')" },
      ],
      notes: [
        'Set allOrNone: false so one bad record does not fail the batch; report each failed item by its position.',
        'Required fields: Contact and Lead need LastName (Lead also Company); Opportunity needs Name, StageName and CloseDate; Account needs Name.',
        'A lookup to another record takes its Id (AccountId), or a reference by its external id: Account: { attributes: { type: "Account" }, My_Ext_Id__c: "A-1" }.',
        'Without an external-id field, re-runs duplicate records: look them up by a unique field first (SOQL IN with up to ~200 values) and update by Id, else create.',
        'Picklist fields accept only their listed values (see the live account details).',
      ],
    },
  },

  getLiveContext,

  configSchema: {
    fields: [
      {
        name: 'loginUrl', type: 'string', label: 'Sign-in URL', required: true, sensitive: false,
        default: 'https://login.salesforce.com', placeholder: 'https://login.salesforce.com',
        helpText: 'https://login.salesforce.com for production and Developer Edition, https://test.salesforce.com for a sandbox, '
          + 'or your My Domain URL (https://acme.my.salesforce.com) if your org blocks the generic login.',
      },
      { name: 'instanceUrl', type: 'hidden', label: 'Instance URL', required: false, sensitive: false },
      { name: 'apiVersion', type: 'hidden', label: 'API version', required: false, sensitive: false },
    ],
  },

  metadata: {
    displayName: 'Salesforce',
    description: 'Any object by SOQL (Bulk API for large extracts); create, update and upsert records — via your own External Client App',
    version: '1.0.0',
  },
};
