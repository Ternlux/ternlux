/**
 * Vendor presets of the REST API connector, main-process side: the preset
 * data, Test Connection, and the references the fetch-writing prompts get.
 *
 *   node --test testing/unit
 *
 * Test Connection runs against a local mock server, so no real token or
 * network access is needed.
 */

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const presets = require('../../plugins/connectors/rest-api/presets');
const restApi = require('../../plugins/connectors/rest-api');
const { presetReferenceForPlaceholders, presetReferenceForCtx } = require('../../public/lib/apiPresets');
const RestApiPrompts = require('../../public/ChatPrompts/RestApi');

const githubConn = {
  name: 'My GitHub',
  dbType: 'rest-api',
  dbConfig: { presetId: 'github', baseUrl: 'https://api.github.com', apiParamKeys: ['Personal access token'] },
};
const hubspotConn = {
  name: 'My HubSpot',
  dbType: 'rest-api',
  dbConfig: { presetId: 'hubspot', baseUrl: 'https://api.hubapi.com', apiParamKeys: ['Access token'] },
};

// Serve one JSON body per request; record what each request carried.
async function mockServer(respond) {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ url: req.url, headers: req.headers });
    const { status, body } = respond(req);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

const TIER1 = ['github', 'hubspot', 'stripe', 'notion', 'airtable', 'jira', 'pipedrive', 'sendgrid',
  'klaviyo', 'intercom', 'linear', 'mailchimp', 'freshdesk', 'calendly', 'typeform'];

test('every preset is complete and survives IPC (structured clone)', () => {
  assert.deepStrictEqual(presets.PRESETS.map((p) => p.id), TIER1);
  for (const p of presets.PRESETS) {
    assert.ok(p.title && p.docsUrl, `${p.id}: title/docsUrl`);
    assert.ok(p.baseUrl ? p.baseUrl.startsWith('https://') : (p.baseUrlPlaceholder && p.baseUrlHelp),
      `${p.id}: a fixed https base URL, or a placeholder and help for a per-account one`);
    assert.ok(p.headers || p.basicAuth, `${p.id}: some way to authenticate`);
    assert.ok(p.credentials.length > 0, `${p.id}: credentials`);
    assert.ok(p.test && p.test.path.startsWith('/'), `${p.id}: test path`);
    assert.ok(p.endpoints.length >= 4, `${p.id}: endpoints`);
    for (const e of p.endpoints) {
      assert.ok(e.path.startsWith('/') && e.label && e.rows, `${p.id}: endpoint ${e.path}`);
    }
    // Every {Key} in a header template names a declared credential.
    const keys = new Set(p.credentials.map((c) => c.key));
    const templates = [...Object.values(p.headers || {}), ...Object.values(p.basicAuth || {})];
    for (const tpl of templates) {
      for (const [, key] of String(tpl).matchAll(/\{([^{}]+)\}/g)) {
        assert.ok(keys.has(key), `${p.id}: header uses undeclared key "${key}"`);
      }
    }
  }
  assert.deepStrictEqual(structuredClone(restApi.presets), restApi.presets);
});

test('endpoint keys are unique within each preset', () => {
  for (const p of presets.PRESETS) {
    const keys = p.endpoints.map((e) => `${e.method || 'GET'} ${e.path}${e.operation ? ` ${e.operation}` : ''}`);
    assert.strictEqual(new Set(keys).size, keys.length, `${p.id} has duplicate endpoints`);
  }
});

test('the REST plugin keeps presetId as a non-sensitive saved field', () => {
  const field = restApi.configSchema.fields.find((f) => f.name === 'presetId');
  assert.ok(field && field.sensitive === false);
});

test('buildPresetHeaders fills saved values and reports missing ones', () => {
  const gh = presets.getPreset('github');
  const { headers, missing } = presets.buildPresetHeaders(gh, { 'Personal access token': 'abc' });
  assert.strictEqual(headers.Authorization, 'Bearer abc');
  assert.strictEqual(headers['X-GitHub-Api-Version'], '2022-11-28');
  assert.deepStrictEqual(missing, []);
  assert.deepStrictEqual(presets.buildPresetHeaders(gh, {}).missing, ['Personal access token']);
  assert.strictEqual(presets.getPreset('nope'), null);
});

test('fetch-prompt reference uses {{PLACEHOLDER}} tokens, never a value', () => {
  const gh = presetReferenceForPlaceholders(githubConn);
  assert.match(gh, /Authorization: Bearer \{\{PERSONAL_ACCESS_TOKEN\}\}/);
  assert.match(gh, /rel="next"/);
  assert.match(gh, /GET \/repos\/\{owner\}\/\{repo\}\/issues/);
  const hs = presetReferenceForPlaceholders(hubspotConn);
  assert.match(hs, /Authorization: Bearer \{\{ACCESS_TOKEN\}\}/);
  assert.match(hs, /paging\.next\.after/);
  assert.match(hs, /POST \/crm\/v3\/objects\/\{object\}\/search/);
  assert.strictEqual(presetReferenceForPlaceholders({ dbType: 'rest-api', dbConfig: {} }), null);
});

test('chat-run reference points at ctx.apiCredentials', () => {
  const ref = presetReferenceForCtx(githubConn);
  assert.ok(ref.includes("params['Personal access token'] from ctx.apiCredentials('My GitHub')"));
});

test('RestApi prompt adds the vendor reference and the picked endpoint only when present', () => {
  const issues = presets.getPreset('github').endpoints.find((e) => e.path === '/repos/{owner}/{repo}/issues');
  const prompt = RestApiPrompts.restApiAnalysisRequest({
    userRequest: 'Pull issues',
    connectionAuthType: 'none',
    connectionBaseUrl: 'https://api.github.com',
    connectionParamKeys: ['Personal access token'],
    presetReference: presetReferenceForPlaceholders(githubConn),
    selectedEndpoint: issues,
  });
  assert.match(prompt, /\*\*Vendor API reference\*\*/);
  assert.match(prompt, /\*\*Endpoint picked in the node form\*\*/);
  assert.match(prompt, /GET \/repos\/\{owner\}\/\{repo\}\/issues \(Issues\)/);
  assert.match(prompt, /ask for any required path value/);

  const plain = RestApiPrompts.restApiAnalysisRequest({
    userRequest: 'x', connectionAuthType: 'none', connectionBaseUrl: 'https://example.com',
  });
  assert.doesNotMatch(plain, /Vendor API reference|Endpoint picked in the node form/);
});

test('Test Connection sends the preset headers and names the signed-in user', async () => {
  const srv = await mockServer((req) => (req.headers.authorization === 'Bearer good'
    ? { status: 200, body: { login: 'octocat' } }
    : { status: 401, body: { message: 'Bad credentials' } }));
  try {
    const config = (token) => ({
      presetId: 'github', baseUrl: `${srv.baseUrl}/`, apiParams: [{ key: 'Personal access token', value: token }],
    });
    assert.deepStrictEqual(await restApi.testConnection(config('good')),
      { success: true, message: 'Connected to GitHub as octocat.' });
    assert.strictEqual(srv.requests[0].url, '/user');
    assert.strictEqual(srv.requests[0].headers.accept, 'application/vnd.github+json');

    const bad = await restApi.testConnection(config('wrong'));
    assert.strictEqual(bad.success, false);
    assert.match(bad.message, /rejected the credentials \(HTTP 401\)\. Bad credentials/);

    const blank = await restApi.testConnection(config(''));
    assert.strictEqual(blank.success, false);
    assert.match(blank.message, /^Enter the Personal access token/);
    assert.strictEqual(srv.requests.length, 2, 'a blank token must not be sent');
  } finally {
    await srv.close();
  }
});

test('Test Connection reports a missing HubSpot scope as 403', async () => {
  const srv = await mockServer(() => ({ status: 403, body: { message: 'This app hasn\'t been granted all required scopes' } }));
  try {
    const res = await restApi.testConnection({
      presetId: 'hubspot', baseUrl: srv.baseUrl, apiParams: [{ key: 'Access token', value: 'x' }],
    });
    assert.strictEqual(res.success, false);
    assert.match(res.message, /refused access \(HTTP 403\) — the credentials are wrong or missing a scope/);
    assert.strictEqual(srv.requests[0].url, '/crm/v3/objects/contacts?limit=1');
  } finally {
    await srv.close();
  }
});

test('a hand-built REST connection keeps the old reachability test', async () => {
  const srv = await mockServer(() => ({ status: 200, body: {} }));
  try {
    const res = await restApi.testConnection({ baseUrl: srv.baseUrl });
    assert.deepStrictEqual(res, { success: true, message: 'HTTP 200' });
  } finally {
    await srv.close();
  }
});

test('a connection saved under an earlier credential name still resolves', async () => {
  const hs = presets.getPreset('hubspot');
  assert.deepStrictEqual(presets.resolveCredentialKeys(hs, ['Access token']), { 'Access token': 'Access token' });
  assert.deepStrictEqual(presets.resolveCredentialKeys(hs, ['Private app token']), { 'Access token': 'Private app token' });
  // Different number of saved keys: no guessing by position.
  assert.deepStrictEqual(presets.resolveCredentialKeys(hs, ['a', 'b']), { 'Access token': 'Access token' });

  const oldConn = { ...hubspotConn, dbConfig: { ...hubspotConn.dbConfig, apiParamKeys: ['Private app token'] } };
  assert.match(presetReferenceForPlaceholders(oldConn), /Authorization: Bearer \{\{PRIVATE_APP_TOKEN\}\}/);
  assert.ok(presetReferenceForCtx(oldConn).includes("params['Private app token']"));

  const srv = await mockServer((req) => ({ status: req.headers.authorization === 'Bearer old' ? 200 : 401, body: {} }));
  try {
    const res = await restApi.testConnection({
      presetId: 'hubspot', baseUrl: srv.baseUrl, apiParams: [{ key: 'Private app token', value: 'old' }],
    });
    assert.deepStrictEqual(res, { success: true, message: 'Connected to HubSpot.' });
  } finally {
    await srv.close();
  }
});


test('every preset sends every credential it asks for', () => {
  for (const p of presets.PRESETS) {
    const values = Object.fromEntries(p.credentials.map((c, i) => [c.key, `v${i}secret`]));
    const { headers, missing } = presets.buildPresetHeaders(p, values);
    assert.deepStrictEqual(missing, [], p.id);
    const sent = JSON.stringify(headers)
      + (headers.Authorization && headers.Authorization.startsWith('Basic ')
        ? Buffer.from(headers.Authorization.slice(6), 'base64').toString() : '');
    for (const v of Object.values(values)) assert.ok(sent.includes(v), `${p.id} never sends ${v}`);
  }
});

test('Basic-auth presets build the header the vendor expects', () => {
  const jira = presets.buildPresetHeaders(presets.getPreset('jira'), { Email: 'a@b.co', 'API token': 't0k' });
  assert.strictEqual(jira.headers.Authorization, `Basic ${Buffer.from('a@b.co:t0k').toString('base64')}`);
  const fd = presets.buildPresetHeaders(presets.getPreset('freshdesk'), { 'API key': 'k3y' });
  assert.strictEqual(fd.headers.Authorization, `Basic ${Buffer.from('k3y:X').toString('base64')}`);
  const ref = presetReferenceForPlaceholders({ name: 'J', dbType: 'rest-api', dbConfig: { presetId: 'jira', apiParamKeys: ['Email', 'API token'] } });
  assert.match(ref, /auth: \{ username: '\{\{EMAIL\}\}', password: '\{\{API_TOKEN\}\}' \}/);
  assert.match(ref, /set per account on this connection \(e\.g\. https:\/\/your-site\.atlassian\.net\)/);
});

test('Test Connection: per-account base URL, Basic auth, and a missing URL', async () => {
  const srv = await mockServer((req) => (req.headers.authorization === `Basic ${Buffer.from('a@b.co:good').toString('base64')}`
    ? { status: 200, body: { displayName: 'Ada' } }
    : { status: 401, body: { errorMessages: ['Client must be authenticated to access this resource.'] } }));
  try {
    const cfg = (token, baseUrl = srv.baseUrl) => ({
      presetId: 'jira', baseUrl, apiParams: [{ key: 'Email', value: 'a@b.co' }, { key: 'API token', value: token }],
    });
    assert.deepStrictEqual(await restApi.testConnection(cfg('good')), { success: true, message: 'Connected to Jira as Ada.' });
    assert.strictEqual(srv.requests[0].url, '/rest/api/3/myself');
    const bad = await restApi.testConnection(cfg('bad'));
    assert.match(bad.message, /rejected the credentials \(HTTP 401\)\. Client must be authenticated/);
    const noUrl = await restApi.testConnection(cfg('good', ''));
    assert.match(noUrl.message, /^Enter your Jira base URL \(e\.g\. https:\/\/your-site\.atlassian\.net\)/);
  } finally {
    await srv.close();
  }
});

test('Test Connection: GraphQL POST, and errors returned with HTTP 200', async () => {
  const srv = await mockServer((req) => (req.headers.authorization === 'lin_good'
    ? { status: 200, body: { data: { viewer: { id: '1', name: 'Grace' } } } }
    : { status: 200, body: { errors: [{ message: 'Authentication required, not authenticated' }] } }));
  try {
    const cfg = (key) => ({ presetId: 'linear', baseUrl: srv.baseUrl, apiParams: [{ key: 'API key', value: key }] });
    assert.deepStrictEqual(await restApi.testConnection(cfg('lin_good')), { success: true, message: 'Connected to Linear as Grace.' });
    assert.strictEqual(srv.requests[0].url, '/graphql');
    const bad = await restApi.testConnection(cfg('nope'));
    assert.strictEqual(bad.success, false);
    assert.match(bad.message, /rejected the credentials \(HTTP 200\)\. Authentication required/);
  } finally {
    await srv.close();
  }
});

test('every preset has a setup guide, linked from the presets page, with working links', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const dir = path.join(__dirname, '../../public/docs/plugins/connectors/api-presets');
  const index = fs.readFileSync(path.join(dir, 'README.md'), 'utf8');
  assert.ok(presets.PRESETS.length >= 15, `expected the 15 presets, got ${presets.PRESETS.length}`);
  for (const preset of presets.PRESETS) {
    const { id } = preset;
    const file = path.join(dir, `${id}.md`);
    assert.ok(fs.existsSync(file), `missing guide ${id}.md`);
    assert.match(index, new RegExp(`\\(${id}\\.md\\)`), `${id}.md not linked from README.md`);
    const doc = fs.readFileSync(file, 'utf8');
    for (const heading of ['## Add the connection', '## Sample data', '## Troubleshooting']) {
      assert.ok(doc.includes(heading), `${id}.md has no "${heading}"`);
    }
    // Every credential the form asks for is named in the guide's form table.
    for (const c of preset.credentials || []) {
      assert.ok(doc.includes(`| ${c.label || c.key} |`), `${id}.md doesn't name the "${c.label || c.key}" field`);
    }
  }
  for (const f of fs.readdirSync(dir)) {
    const doc = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const [, link] of doc.matchAll(/\]\(([^)#]+\.md)\)/g)) {
      assert.ok(fs.existsSync(path.join(dir, link)), `${f} links to missing ${link}`);
    }
  }
});
