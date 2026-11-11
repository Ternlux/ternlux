/**
 * Microsoft Dynamics 365 / Dataverse connector — every table in the
 * environment (accounts, contacts, leads, opportunities, cases, custom
 * tables) through the Dataverse Web API (OData v4), read and written.
 * Signs in with the user's own Microsoft Entra app registration, delegated
 * (the user's own permissions apply).
 *
 * Microsoft rotates refresh tokens; the app's token store saves each new one
 * (see public/lib/oauthTokens.js), so the connection keeps working.
 *
 * API facts cross-checked against Microsoft's Dataverse Web API docs, the
 * Airbyte source-microsoft-dataverse docs (tables discovered from
 * EntityDefinitions, odata.maxpagesize, change tracking) and the n8n
 * Microsoft Dynamics CRM node and credential. No code from either project.
 */

const orgUrl = (config) => {
  const raw = String(config.orgUrl || '').trim().replace(/\/+$/, '');
  return raw && !/^https:\/\//i.test(raw) ? `https://${raw}` : raw;
};
const tenant = (config) => String(config.tenantId || 'organizations').trim() || 'organizations';

const MAX_FIELDS = 200;

function mentionedTables(defs, request) {
  const text = ` ${String(request || '').toLowerCase().replace(/[^a-z0-9_]+/g, ' ')} `;
  const has = (w) => w && w.length > 2 && (text.includes(` ${w} `) || text.includes(` ${w}s `) || (w.endsWith('y') && text.includes(` ${w.slice(0, -1)}ies `)));
  return defs.filter((d) => {
    const label = (d.DisplayName?.UserLocalizedLabel?.Label || '').toLowerCase();
    return has(d.LogicalName) || has(label) || has(String(d.EntitySetName || '').toLowerCase());
  }).slice(0, 4);
}

async function getLiveContext(config, { request, mode, axios }) {
  const base = config.baseUrl;
  const { data } = await axios.get(`${base}/EntityDefinitions`, {
    params: { $select: 'LogicalName,EntitySetName,DisplayName,IsCustomEntity,PrimaryIdAttribute,PrimaryNameAttribute', $filter: 'IsValidForAdvancedFind eq true' },
  });
  const defs = data.value || [];
  const custom = defs.filter((d) => d.IsCustomEntity);
  const lines = [`Dataverse environment ${orgUrl(config)}: ${defs.length} tables.`,
    'Use the EntitySetName in URLs (e.g. /accounts), LogicalName in $select of lookups.',
    `Custom tables (LogicalName → EntitySetName): ${custom.slice(0, 150).map((d) => `${d.LogicalName} → /${d.EntitySetName}`).join('; ') || 'none'}.`];

  for (const d of mentionedTables(defs, request)) {
    // eslint-disable-next-line no-await-in-loop
    const { data: a } = await axios.get(`${base}/EntityDefinitions(LogicalName='${d.LogicalName}')/Attributes`, {
      params: { $select: 'LogicalName,AttributeType,DisplayName,IsCustomAttribute,RequiredLevel,IsValidForCreate,IsValidForUpdate,IsValidForRead' },
    });
    const attrs = (a.value || []).filter((x) => x.IsValidForRead && !/^(yomi|.*_base$)/.test(x.LogicalName)).slice(0, MAX_FIELDS);
    lines.push('', `${d.LogicalName} (/${d.EntitySetName}; id ${d.PrimaryIdAttribute}, name ${d.PrimaryNameAttribute}) columns right now:`);
    for (const x of attrs) {
      const bits = [x.AttributeType];
      if (x.IsCustomAttribute) bits.push('custom');
      if (mode === 'write') {
        if (!x.IsValidForCreate && !x.IsValidForUpdate) bits.push('read-only');
        else if (x.RequiredLevel?.Value === 'ApplicationRequired' || x.RequiredLevel?.Value === 'SystemRequired') bits.push('required');
      }
      lines.push(`  - ${x.LogicalName} (${x.DisplayName?.UserLocalizedLabel?.Label || ''}): ${bits.join(', ')}`);
    }
    if (mode === 'write') {
      try {
        // eslint-disable-next-line no-await-in-loop
        const { data: k } = await axios.get(`${base}/EntityDefinitions(LogicalName='${d.LogicalName}')/Keys`, { params: { $select: 'LogicalName,KeyAttributes' } });
        const keys = (k.value || []).map((x) => (x.KeyAttributes || []).join('+'));
        lines.push(keys.length ? `  Alternate keys (usable for upsert): ${keys.join('; ')}` : '  No alternate keys: upsert must look records up first, then PATCH by id.');
      } catch (_) { /* keys are optional */ }
    }
  }
  return lines.join('\n');
}

module.exports = {
  type: 'connector',
  id: 'microsoft-dynamics',
  name: 'Microsoft Dynamics 365',
  dbCategory: 'API',

  oauth: {
    authorizeUrl: (c) => `https://login.microsoftonline.com/${tenant(c)}/oauth2/v2.0/authorize`,
    tokenUrl: (c) => `https://login.microsoftonline.com/${tenant(c)}/oauth2/v2.0/token`,
    scopes: (c) => [`${orgUrl(c)}/user_impersonation`, 'offline_access'],
    pkce: true,
    clientIdLabel: 'Application (client) ID',
    clientIdHelp: 'Microsoft Entra admin center → App registrations → your app → Overview.',
    clientSecretHelp: 'Your app → Certificates & secrets → New client secret → copy the Value.',
  },

  apiBaseUrl: (config) => (orgUrl(config) ? `${orgUrl(config)}/api/data/v9.2` : ''),

  apiReference: {
    title: 'Dataverse Web API v9.2 (Dynamics 365)',
    docsUrl: 'https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/overview',
    baseUrl: null,
    baseUrlPlaceholder: 'https://yourorg.crm.dynamics.com/api/data/v9.2',
    headers: {
      Authorization: 'Bearer {accessToken}',
      Accept: 'application/json',
      'OData-MaxVersion': '4.0',
      'OData-Version': '4.0',
      Prefer: 'odata.maxpagesize=5000,odata.include-annotations="OData.Community.Display.V1.FormattedValue"',
    },
    test: { path: '/WhoAmI', identity: (d) => (d.UserId ? `user ${d.UserId}` : null) },
    pagination: 'Collections return { value: [...], "@odata.nextLink" }; while response.data["@odata.nextLink"] is set, GET that full URL '
      + '(keep the same headers). Pages hold up to 5000 rows.',
    endpoints: [
      { method: 'GET', path: '/{entitySet}', label: 'Rows of a table (accounts, contacts, leads, opportunities, incidents, custom…)', rows: '`value` array',
        params: '$select=name,revenue,createdon (always select columns), $filter=modifiedon gt 2025-01-01T00:00:00Z and statecode eq 0, $orderby=modifiedon, '
          + '$expand=primarycontactid($select=fullname,emailaddress1), $top',
        notes: 'Choice (option set) columns come back as numbers; the label is in the "<column>@OData.Community.Display.V1.FormattedValue" key. '
          + 'Lookups appear as _<name>_value (a GUID).' },
      { method: 'GET', path: '/{entitySet}?fetchXml=<encoded FetchXML>', label: 'FetchXML query (aggregates, link-entities)', rows: '`value` array',
        params: 'fetchXml=encodeURIComponent(\'<fetch aggregate="true"><entity name="opportunity"><attribute name="estimatedvalue" aggregate="sum" alias="total"/></entity></fetch>\')' },
      { method: 'GET', path: '/EntityDefinitions', label: 'Every table (find EntitySetName)', rows: '`value` array',
        params: '$select=LogicalName,EntitySetName,DisplayName,IsCustomEntity' },
      { method: 'GET', path: "/EntityDefinitions(LogicalName='{table}')/Attributes", label: 'A table\'s columns and types', rows: '`value` array',
        params: '$select=LogicalName,AttributeType,DisplayName,RequiredLevel' },
      { method: 'GET', path: '/WhoAmI', label: 'The signed-in user and business unit', rows: 'one object' },
    ],
    notes: [
      'URLs use the plural EntitySetName (/accounts, /contacts, /incidents for cases); $select uses column LogicalNames.',
      'GUIDs are written bare in URLs: /accounts(00000000-0000-0000-0000-000000000000).',
      'Dates are UTC ISO-8601. Money columns also have a _base column in the org currency.',
      'Throttling: 429 with Retry-After — wait that many seconds.',
    ],
    writes: {
      endpoints: [
        { method: 'POST', path: '/{entitySet}', label: 'Create a row', batch: 1, upsert: null,
          body: '{ name: "Contoso", revenue: 5000, "primarycontactid@odata.bind": "/contacts(<guid>)" }',
          notes: 'Send header Prefer: return=representation to get the created row back; otherwise the id is in the OData-EntityId response header.' },
        { method: 'PATCH', path: '/{entitySet}({id})', label: 'Update a row by id', batch: 1, upsert: 'id', body: '{ …columns to change }',
          notes: 'Add header If-Match: * to update only (never create).' },
        { method: 'PATCH', path: "/{entitySet}({keyColumn}='{value}')", label: 'Upsert on an alternate key', batch: 1, upsert: 'the alternate key',
          body: '{ …columns }', notes: 'Creates the row when no row has that key. Only works for keys defined on the table (see the live account details).' },
        { method: 'GET', path: "/{entitySet}?$select={idColumn}&$filter=emailaddress1 eq 'a@b.com'", label: 'Look a row up first (no alternate key)', batch: 1, upsert: null, body: '—' },
      ],
      notes: [
        'Lookups are set with "<navigation property>@odata.bind": "/<entitySet>(<guid>)" — the navigation property name, not the _…_value column.',
        'Choice columns take the numeric value, not the label.',
        'One row per request; the runtime calls the function per batch, so keep batchSize 1–25 and send them one after another.',
      ],
    },
  },

  getLiveContext,

  configSchema: {
    fields: [
      { name: 'orgUrl', type: 'string', label: 'Environment URL', required: true, sensitive: false,
        placeholder: 'https://yourorg.crm.dynamics.com',
        helpText: 'Power Platform admin center → Environments → your environment → Environment URL.' },
      { name: 'tenantId', type: 'string', label: 'Directory (tenant) ID', required: false, sensitive: false, default: 'organizations',
        helpText: 'Your app registration\'s Directory (tenant) ID, or leave "organizations" for a multi-tenant app.' },
    ],
  },

  metadata: {
    displayName: 'Microsoft Dynamics 365',
    description: 'Every Dataverse table — accounts, contacts, leads, opportunities, cases, custom tables — read, create, update and upsert',
    version: '1.0.0',
  },
};
