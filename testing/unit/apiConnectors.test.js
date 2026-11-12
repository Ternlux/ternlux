/**
 * OAuth / API connectors (plugins/connectors/<id> with dbCategory 'API'):
 * the token refresh hook, the generic OAuth flow, the placeholders and
 * references the AI gets, live account context, the report-file helpers and
 * every connector's data and setup guide.
 *
 *   node --test testing/unit
 *
 * Every request goes to a local mock server — no real provider, no real token.
 */

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const { ensureFreshOAuthConfig, needsRefresh } = require('../../public/lib/oauthTokens');
const {
  completeApiConnector, resolveConnectorConfig, connectorPlaceholderNames, liveContextFor, _internal,
} = require('../../public/lib/apiConnectors');
const fetchTools = require('../../public/lib/fetchTools');
const ApiFetch = require('../../public/NodeExecution/ApiFetch');
const RestApiPrompts = require('../../public/ChatPrompts/RestApi');

const CONNECTORS = ['google-analytics', 'salesforce', 'google-search-console', 'google-ads', 'youtube-analytics',
  'meta-ads', 'facebook-pages', 'linkedin-ads', 'linkedin-pages', 'microsoft-dynamics', 'zoho-crm', 'outreach',
  'salesloft', 'tiktok-ads', 'microsoft-ads', 'pinterest-ads', 'snapchat-ads', 'amazon-ads'];
const load = (id) => completeApiConnector(require(`../../plugins/connectors/${id}`));

async function mockServer(respond) {
  const requests = [];
  const srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, headers: req.headers, body: raw });
      const [status, data] = respond(req, raw, requests.length);
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${srv.address().port}`, requests, close: () => new Promise((r) => srv.close(r)) };
}

// ── Token refresh hook ─────────────────────────────────────────────────────

test('needsRefresh: only with a refresh token, and only near expiry', () => {
  const now = 1_000_000_000_000;
  assert.strictEqual(needsRefresh({ accessToken: 'a' }, now), false, 'no refresh token');
  assert.strictEqual(needsRefresh({ accessToken: 'a', refreshToken: 'r' }, now), false, 'no recorded expiry');
  assert.strictEqual(needsRefresh({ accessToken: 'a', refreshToken: 'r', expiryDate: now + 60 * 60e3 }, now), false);
  assert.strictEqual(needsRefresh({ accessToken: 'a', refreshToken: 'r', expiryDate: now + 60e3 }, now), true, 'inside the margin');
  assert.strictEqual(needsRefresh({ refreshToken: 'r' }, now), true, 'no access token yet');
});

test('an expired token is refreshed and the new tokens are saved', async () => {
  const saved = [];
  const plugin = { authType: 'oauth2', refreshAccessToken: async () => ({ success: true, tokens: { accessToken: 'new', refreshToken: 'rot2', expiryDate: 42 }, extra: { instanceUrl: 'https://x' } }) };
  const out = await ensureFreshOAuthConfig({
    connectionId: 'c1', plugin, config: { accessToken: 'old', refreshToken: 'rot1', expiryDate: 1, other: 'kept' },
    persist: async (...a) => saved.push(a),
  });
  assert.strictEqual(out.accessToken, 'new');
  assert.strictEqual(out.refreshToken, 'rot2');
  assert.strictEqual(out.other, 'kept');
  assert.strictEqual(out.instanceUrl, 'https://x');
  assert.deepStrictEqual(saved, [['c1', { accessToken: 'new', refreshToken: 'rot2' }, { expiryDate: 42, instanceUrl: 'https://x' }]]);
});

test('a provider that does not rotate keeps the saved refresh token', async () => {
  const plugin = { authType: 'oauth2', refreshAccessToken: async () => ({ success: true, tokens: { accessToken: 'new' } }) };
  const out = await ensureFreshOAuthConfig({ connectionId: 'c2', plugin, config: { refreshToken: 'keep', expiryDate: 1, accessToken: 'x' }, persist: async () => {} });
  assert.strictEqual(out.refreshToken, 'keep');
});

test('two runs that start together share one refresh (a rotating token is spent once)', async () => {
  let calls = 0;
  const plugin = { authType: 'oauth2', refreshAccessToken: async () => { calls += 1; await new Promise((r) => setTimeout(r, 20)); return { success: true, tokens: { accessToken: `t${calls}` } }; } };
  const cfg = { accessToken: 'a', refreshToken: 'r', expiryDate: 1 };
  const [a, b] = await Promise.all([
    ensureFreshOAuthConfig({ connectionId: 'c3', plugin, config: cfg, persist: async () => {} }),
    ensureFreshOAuthConfig({ connectionId: 'c3', plugin, config: cfg, persist: async () => {} }),
  ]);
  assert.strictEqual(calls, 1);
  assert.strictEqual(a.accessToken, 't1');
  assert.strictEqual(b.accessToken, 't1');
});

test('a failed refresh keeps the old config and says why; a valid token is left alone unless forced', async () => {
  const failing = { authType: 'oauth2', refreshAccessToken: async () => ({ success: false, message: 'invalid_grant' }) };
  const out = await ensureFreshOAuthConfig({ connectionId: 'c4', plugin: failing, config: { accessToken: 'a', refreshToken: 'r', expiryDate: 1 }, persist: async () => { throw new Error('must not save'); } });
  assert.strictEqual(out.accessToken, 'a');
  assert.strictEqual(out.oauthRefreshError, 'invalid_grant');

  let calls = 0;
  const ok = { authType: 'oauth2', refreshAccessToken: async () => { calls += 1; return { success: true, tokens: { accessToken: 'b' } }; } };
  const fresh = { accessToken: 'a', refreshToken: 'r', expiryDate: Date.now() + 3600e3 };
  await ensureFreshOAuthConfig({ connectionId: 'c5', plugin: ok, config: fresh, persist: async () => {} });
  assert.strictEqual(calls, 0);
  const forced = await ensureFreshOAuthConfig({ connectionId: 'c5', plugin: ok, config: fresh, persist: async () => {}, force: true });
  assert.strictEqual(calls, 1);
  assert.strictEqual(forced.accessToken, 'b');
  // Non-OAuth plugins are never touched.
  const same = await ensureFreshOAuthConfig({ connectionId: 'c6', plugin: { authType: 'apiKey' }, config: { x: 1 }, persist: async () => {} });
  assert.deepStrictEqual(same, { x: 1 });
});

// ── Generic OAuth flow ─────────────────────────────────────────────────────

test('authorization URL carries client, redirect, scopes, state and a PKCE challenge', () => {
  const sf = load('salesforce');
  const r = sf.getAuthorizationUrl({ clientId: 'cid', state: 'st', loginUrl: 'https://test.salesforce.com' });
  assert.ok(r.success);
  const u = new URL(r.authUrl);
  assert.strictEqual(u.origin + u.pathname, 'https://test.salesforce.com/services/oauth2/authorize');
  assert.strictEqual(u.searchParams.get('client_id'), 'cid');
  assert.strictEqual(u.searchParams.get('redirect_uri'), 'http://localhost:3000/oauth/callback');
  assert.strictEqual(u.searchParams.get('scope'), 'api refresh_token offline_access');
  assert.strictEqual(u.searchParams.get('state'), 'st');
  assert.strictEqual(u.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(r.codeVerifier && r.codeVerifier.length >= 43);
  const ga = new URL(load('google-analytics').getAuthorizationUrl({ clientId: 'g' }).authUrl);
  assert.strictEqual(ga.searchParams.get('access_type'), 'offline');
  assert.strictEqual(ga.searchParams.get('prompt'), 'consent');
  // Meta joins scopes with commas.
  const meta = new URL(load('meta-ads').getAuthorizationUrl({ clientId: 'm' }).authUrl);
  assert.match(meta.searchParams.get('scope'), /^ads_read,ads_management/);
});

test('code exchange and refresh post the right form; Basic client auth when the provider wants it', async () => {
  const srv = await mockServer((req, body) => [200, { access_token: 'AT', refresh_token: body.includes('refresh_token=RT') ? undefined : 'RT', expires_in: 3600, instance_url: 'https://acme.my.salesforce.com' }]);
  try {
    const spec = { tokenUrl: `${srv.url}/token`, parseTokens: (d) => ({ accessToken: d.access_token, refreshToken: d.refresh_token, expiresIn: d.expires_in, extra: { instanceUrl: d.instance_url } }) };
    const exchange = _internal.makeExchange(spec, require('axios'));
    const ex = await exchange({ clientId: 'cid', clientSecret: 'sec', codeVerifier: 'ver' }, 'CODE');
    assert.ok(ex.success, ex.message);
    assert.strictEqual(ex.tokens.accessToken, 'AT');
    assert.strictEqual(ex.tokens.refreshToken, 'RT');
    assert.ok(ex.tokens.expiryDate > Date.now());
    assert.strictEqual(ex.extra.instanceUrl, 'https://acme.my.salesforce.com');
    const form = new URLSearchParams(srv.requests[0].body);
    assert.strictEqual(form.get('grant_type'), 'authorization_code');
    assert.strictEqual(form.get('code'), 'CODE');
    assert.strictEqual(form.get('code_verifier'), 'ver');
    assert.strictEqual(form.get('client_secret'), 'sec');

    const refresh = _internal.makeRefresh({ ...spec, clientAuth: 'basic' }, require('axios'));
    const rf = await refresh({ clientId: 'cid', clientSecret: 'sec', refreshToken: 'RT' });
    assert.ok(rf.success);
    const r2 = srv.requests[1];
    assert.strictEqual(r2.headers.authorization, `Basic ${Buffer.from('cid:sec').toString('base64')}`);
    assert.strictEqual(new URLSearchParams(r2.body).get('client_secret'), null, 'Basic auth keeps the secret out of the body');
    assert.strictEqual(new URLSearchParams(r2.body).get('grant_type'), 'refresh_token');
  } finally { await srv.close(); }
});

test('a provider error comes back as its own message', async () => {
  const srv = await mockServer(() => [400, { error: 'invalid_grant', error_description: 'expired authorization code' }]);
  try {
    const ex = await _internal.makeExchange({ tokenUrl: `${srv.url}/t` }, require('axios'))({ clientId: 'c' }, 'x');
    assert.strictEqual(ex.success, false);
    assert.strictEqual(ex.message, 'expired authorization code');
  } finally { await srv.close(); }
});

// ── Placeholders, base URL, headers ────────────────────────────────────────

test('connector config gives the code its placeholders, base URL and headers', () => {
  const ads = load('google-ads');
  const r = resolveConnectorConfig(ads, { accessToken: 'AT', developerToken: 'DT' });
  assert.deepStrictEqual(r.connectorTokens, { ACCESS_TOKEN: 'AT', DEVELOPER_TOKEN: 'DT', LOGIN_CUSTOMER_ID: '' });
  assert.strictEqual(r.connectorHeaders.Authorization, 'Bearer AT');
  assert.strictEqual(r.connectorHeaders['developer-token'], 'DT');
  assert.ok(!('login-customer-id' in r.connectorHeaders), 'an optional header left blank is dropped');
  assert.deepStrictEqual(connectorPlaceholderNames(ads), ['{{ACCESS_TOKEN}}', '{{DEVELOPER_TOKEN}}', '{{LOGIN_CUSTOMER_ID}}']);

  const sf = resolveConnectorConfig(load('salesforce'), { accessToken: 'AT', instanceUrl: 'https://acme.my.salesforce.com/', apiVersion: '66.0' });
  assert.strictEqual(sf.baseUrl, 'https://acme.my.salesforce.com/services/data/v66.0');
  assert.strictEqual(sf.connectorTokens.INSTANCE_URL, 'https://acme.my.salesforce.com/');
  const zoho = resolveConnectorConfig(load('zoho-crm'), { accessToken: 'Z', apiDomain: 'https://www.zohoapis.eu' });
  assert.strictEqual(zoho.baseUrl, 'https://www.zohoapis.eu/crm/v7');
  assert.strictEqual(zoho.connectorHeaders.Authorization, 'Zoho-oauthtoken Z');
  assert.strictEqual(resolveConnectorConfig(load('amazon-ads'), { region: 'EU' }).baseUrl, 'https://advertising-api-eu.amazon.com');
  assert.strictEqual(resolveConnectorConfig(load('tiktok-ads'), { accessToken: 'T' }).connectorHeaders['Access-Token'], 'T');
});

test('a node\'s fetch code gets {{ACCESS_TOKEN}}, and a 401 forces one refresh and retry', async () => {
  const seen = [];
  const srv = await mockServer((req) => {
    seen.push(req.headers.authorization);
    return req.headers.authorization === 'Bearer fresh' ? [200, { data: [] }] : [401, { error: 'expired' }];
  });
  const calls = [];
  ApiFetch.initialize(async (_id, cfg, options = {}) => {
    calls.push(options.forceRefresh === true);
    const token = options.forceRefresh ? 'fresh' : 'stale';
    return { ...cfg, baseUrl: srv.url, refreshToken: 'r', accessToken: token, connectorTokens: { ACCESS_TOKEN: token } };
  });
  try {
    const out = await ApiFetch.handleExecuteApiFetch({
      apiConnectionId: 'sf1',
      apiFetchCode: `async function f({ axios, tools }) {
        if (typeof tools.gunzip !== 'function') throw new Error('tools missing');
        const r = await axios.get('{{BASE_URL}}/q', { headers: { Authorization: 'Bearer {{ACCESS_TOKEN}}' } });
        return r.data.data;
      }`,
      targetCollection: 'rows',
      workflowId: 'wf-test',
      nodeId: 'n1',
    });
    // Outside Electron the runner cannot place the output table (no app
    // paths) — that happens after the fetch, so the requests are what count.
    assert.doesNotMatch(String(out.error || ''), /Fetch function threw/, out.error);
    assert.deepStrictEqual(seen, ['Bearer stale', 'Bearer fresh']);
    assert.deepStrictEqual(calls, [false, true]);
  } finally { await srv.close(); }
});

test('the fetch prompt lists the connector placeholders and the live account section', () => {
  const prompt = RestApiPrompts.restApiAnalysisRequest({
    userRequest: 'open opportunities',
    connectionParamKeys: [],
    connectorPlaceholders: ['{{ACCESS_TOKEN}}', '{{INSTANCE_URL}}'],
    liveContext: 'Custom objects (API name — label): Invoice__c — Invoice.',
    presetReference: 'Salesforce REST API reference',
  });
  assert.match(prompt, /- \{\{ACCESS_TOKEN\}\}/);
  assert.match(prompt, /- \{\{INSTANCE_URL\}\}/);
  assert.match(prompt, /\*\*The user's account right now\*\*/);
  assert.match(prompt, /Invoice__c/);
  assert.match(prompt, /\{ axios, tools \}/);
  const plain = RestApiPrompts.restApiAnalysisRequest({ userRequest: 'x', connectionParamKeys: [] });
  assert.doesNotMatch(plain, /account right now/);
});

// ── Live account context ───────────────────────────────────────────────────

function fakeAxios(routes) {
  const calls = [];
  const handle = async (url) => {
    calls.push(url);
    const hit = Object.entries(routes).find(([k]) => url.includes(k));
    if (!hit) { const e = new Error(`no route ${url}`); e.response = { status: 404 }; throw e; }
    return { data: typeof hit[1] === 'function' ? hit[1](url) : hit[1] };
  };
  return { calls, get: (url) => handle(url), post: (url) => handle(url) };
}

test('GA4 live context lists properties and, for the named one, its custom dimensions and metrics', async () => {
  const ga = load('google-analytics');
  const axios = fakeAxios({
    accountSummaries: { accountSummaries: [{ displayName: 'Acme', propertySummaries: [{ property: 'properties/111', displayName: 'Shop' }, { property: 'properties/222', displayName: 'Blog' }] }] },
    '/properties/222/metadata': { dimensions: [{ apiName: 'date', uiName: 'Date' }, { apiName: 'customEvent:plan', uiName: 'Plan', customDefinition: true }], metrics: [{ apiName: 'sessions', uiName: 'Sessions' }, { apiName: 'customEvent:ltv', uiName: 'LTV', type: 'TYPE_CURRENCY', customDefinition: true }, { apiName: 'keyEvents:purchase' }] },
  });
  const text = await ga.getLiveContext({}, { request: 'sessions by plan on the Blog property', axios });
  assert.match(text, /111 "Shop"/);
  assert.match(text, /customEvent:plan — Plan/);
  assert.match(text, /customEvent:ltv — LTV/);
  assert.match(text, /keyEvents:purchase/);
  assert.ok(axios.calls.some((u) => u.includes('/properties/222/metadata')));
});

test('Salesforce live context describes the objects the request names, with write details', async () => {
  const sf = load('salesforce');
  const axios = fakeAxios({
    '/describe': { fields: [
      { name: 'Id', label: 'Opportunity ID', type: 'id', createable: false, updateable: false },
      { name: 'StageName', label: 'Stage', type: 'picklist', createable: true, updateable: true, nillable: false, picklistValues: [{ value: 'Prospecting', active: true }, { value: 'Closed Won', active: true }] },
      { name: 'Ext_Id__c', label: 'External', type: 'string', custom: true, externalId: true, createable: true, updateable: true, nillable: true },
    ] },
    '/sobjects': { sobjects: [{ name: 'Opportunity', label: 'Opportunity', labelPlural: 'Opportunities', queryable: true }, { name: 'Invoice__c', label: 'Invoice', custom: true, queryable: true }] },
  });
  const text = await sf.getLiveContext({ baseUrl: 'https://x/services/data/v64.0' }, { request: 'upsert opportunities from the sheet', mode: 'write', axios });
  assert.match(text, /Invoice__c — Invoice/);
  assert.match(text, /StageName \(Stage\): picklist, required on create, values: Prospecting \| Closed Won/);
  assert.match(text, /Upsert keys \(external-id fields\) on Opportunity: Ext_Id__c/);
});

test('live context is cached per connection and request, and a failure gives an empty string', async () => {
  let n = 0;
  const plugin = { id: 'x', dbCategory: 'API', apiReference: { headers: {} }, getLiveContext: async () => { n += 1; return 'ctx'; } };
  assert.strictEqual(await liveContextFor(plugin, 'k1', {}, { request: 'a' }), 'ctx');
  assert.strictEqual(await liveContextFor(plugin, 'k1', {}, { request: 'a' }), 'ctx');
  assert.strictEqual(n, 1);
  const broken = { id: 'y', dbCategory: 'API', apiReference: { headers: {} }, getLiveContext: async () => { throw new Error('boom'); } };
  assert.strictEqual(await liveContextFor(broken, 'k2', {}, {}), '');
});

// ── Report-file helpers ────────────────────────────────────────────────────

test('fetch tools: gunzip, unzip, CSV, JSON lines and sha256', () => {
  assert.strictEqual(fetchTools.gunzip(zlib.gzipSync('[{"a":1}]')), '[{"a":1}]');
  assert.strictEqual(fetchTools.gunzip(Buffer.from('plain')), 'plain');
  assert.deepStrictEqual(fetchTools.parseCsv('Name,"Spend, USD"\n"A ""x""",1.5\r\nB,2\n'), [{ Name: 'A "x"', 'Spend, USD': '1.5' }, { Name: 'B', 'Spend, USD': '2' }]);
  assert.deepStrictEqual(fetchTools.parseCsv('Report,x\nh1,h2\n1,2\n©2025 Microsoft,\n', { skipRows: 1, skipFooterMatching: '^©' }), [{ h1: '1', h2: '2' }]);
  assert.deepStrictEqual(fetchTools.parseJsonLines('{"a":1}\n\n{"a":2}\n'), [{ a: 1 }, { a: 2 }]);
  assert.strictEqual(fetchTools.sha256('a@b.com'), require('crypto').createHash('sha256').update('a@b.com').digest('hex'));

  // A one-entry deflated ZIP, built by hand.
  const content = Buffer.from('Campaign,Spend\nX,3\n');
  const deflated = zlib.deflateRawSync(content);
  const name = Buffer.from('r.csv');
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(8, 8); local.writeUInt32LE(deflated.length, 18); local.writeUInt32LE(content.length, 22); local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(8, 10); central.writeUInt32LE(deflated.length, 20); central.writeUInt32LE(content.length, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE(0, 42);
  const cdOffset = local.length + name.length + deflated.length;
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(central.length + name.length, 12); end.writeUInt32LE(cdOffset, 16);
  const zip = Buffer.concat([local, name, deflated, central, name, end]);
  const files = fetchTools.unzip(zip);
  assert.deepStrictEqual(files, [{ name: 'r.csv', text: 'Campaign,Spend\nX,3\n' }]);
  assert.deepStrictEqual(fetchTools.parseCsv(files[0].text), [{ Campaign: 'X', Spend: '3' }]);
});

// ── Every connector ────────────────────────────────────────────────────────

test('every connector loads, fills its OAuth fields, and its reference survives IPC', () => {
  for (const id of CONNECTORS) {
    const p = load(id);
    assert.strictEqual(p.type, 'connector', id);
    assert.strictEqual(p.id, id);
    assert.strictEqual(p.dbCategory, 'API', id);
    assert.strictEqual(p.authType, 'oauth2', id);
    for (const m of ['getAuthorizationUrl', 'exchangeCodeForTokens', 'testConnection', 'getTables', 'getColumns', 'runQuery']) {
      assert.strictEqual(typeof p[m], 'function', `${id}.${m}`);
    }
    const names = p.configSchema.fields.map((f) => f.name);
    for (const f of ['clientId', 'clientSecret', 'redirectUri', 'accessToken', 'refreshToken', 'expiryDate']) assert.ok(names.includes(f), `${id}: field ${f}`);
    for (const f of p.configSchema.fields.filter((x) => ['clientSecret', 'accessToken', 'refreshToken'].includes(x.name))) assert.strictEqual(f.sensitive, true, `${id}: ${f.name} must be encrypted`);
    const ref = JSON.parse(JSON.stringify(p.apiReference));
    assert.ok(ref.title && ref.docsUrl && ref.pagination, `${id}: reference basics`);
    assert.ok(ref.baseUrl || ref.baseUrlPlaceholder, `${id}: base URL`);
    assert.ok(Object.values(ref.headers).some((h) => h.includes('{accessToken}')), `${id}: sends the access token`);
    assert.ok(ref.endpoints.length >= 3, `${id}: endpoints`);
    for (const e of ref.endpoints) assert.ok(e.path && e.label && e.rows, `${id}: endpoint ${e.path}`);
    assert.ok(Array.isArray(ref.writes.endpoints), `${id}: writes block`);
    const url = p.getAuthorizationUrl({ clientId: 'c', state: 's', orgUrl: 'https://o.crm.dynamics.com', loginUrl: 'https://login.salesforce.com' });
    assert.ok(url.success && /^https:\/\//.test(url.authUrl), `${id}: authorization URL`);
  }
});

test('every connector has a setup guide, linked from the OAuth page', () => {
  const dir = path.join(__dirname, '../../public/docs/plugins/connectors/oauth-connectors');
  const index = fs.readFileSync(path.join(dir, 'README.md'), 'utf8');
  for (const id of CONNECTORS) {
    const file = path.join(dir, `${id}.md`);
    assert.ok(fs.existsSync(file), `missing guide ${id}.md`);
    assert.match(index, new RegExp(`\\(${id}\\.md\\)`), `${id}.md not linked`);
    const doc = fs.readFileSync(file, 'utf8');
    for (const h of ['## Create your app', '## Add the connection', '## Troubleshooting']) assert.ok(doc.includes(h), `${id}.md has no "${h}"`);
    assert.ok(doc.includes('http://localhost:3000/oauth/callback'), `${id}.md names the redirect URL`);
  }
});

test('a read-only connector is not offered as a destination', async () => {
  const { apiAcceptsRows } = await import('../../src/components/Workflows/joinDestinations.js').catch(() => ({}));
  // joinDestinations is an ES module for the renderer; check the rule on the data instead.
  const accepts = apiAcceptsRows || ((plugin) => !!(plugin.apiReference.writes.endpoints.length));
  assert.strictEqual(accepts(load('google-analytics')), false);
  assert.strictEqual(accepts(load('salesforce')), true);
});
