/**
 * Writing rows to a REST API (an Output to an API connection, or a Join whose
 * destination is one): the shared writer in public/NodeExecution/ApiWrite.js,
 * the write reference the AI gets, and the build-time approval.
 *
 *   node --test testing/unit
 *
 * Every request goes to a local mock server — no real API, no real key.
 */

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const ApiFetch = require('../../public/NodeExecution/ApiFetch');
const { writeRowsToApi } = require('../../public/NodeExecution/ApiWrite');
const presets = require('../../plugins/connectors/rest-api/presets');
const { presetReferenceForPlaceholders } = require('../../public/lib/apiPresets');
const workflowBuilder = require('../../public/chat/workflowBuilder');

// A mock API: records every request; `respond(req, body)` decides the answer.
async function mockApi(respond) {
  const requests = [];
  const srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : null;
      requests.push({ method: req.method, url: req.url, headers: req.headers, body });
      const [status, data, headers] = respond(req, body, requests.length);
      res.writeHead(status, { 'Content-Type': 'application/json', ...(headers || {}) });
      res.end(JSON.stringify(data));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${srv.address().port}`;
  return { url, requests, close: () => new Promise((r) => srv.close(r)) };
}

// Pages as the output executor's reader yields them.
async function* pagesOf(rows, size = 7) {
  for (let i = 0; i < rows.length; i += size) yield rows.slice(i, i + size);
}

const rows = (n) => Array.from({ length: n }, (_, i) => ({ email: `p${i}@example.com`, name: `P${i}` }));

// sendBatch the way the prompt asks for it: one batch request, per-row errors read back.
const BATCH_CODE = `async function sendBatch({ axios, rows }) {
  const res = await axios.post('{{BASE_URL}}/contacts/batch', { inputs: rows.map((r) => ({ email: r.email, name: r.name })) },
    { headers: { Authorization: 'Bearer {{API_KEY}}' } });
  const failed = (res.data.errors || []).map((e) => ({ index: e.index, error: e.message }));
  return { sent: rows.length - failed.length, failed };
}`;

function initWith(baseUrl) {
  ApiFetch.initialize(async (_id, cfg) => ({ ...cfg, baseUrl, apiParams: [{ key: 'API key', value: 'secret-123' }] }));
}

test('rows are re-cut into batches of the code\'s size, with credentials filled in', async () => {
  const api = await mockApi(() => [200, { errors: [] }]);
  try {
    initWith(api.url);
    const out = await writeRowsToApi({
      pages: pagesOf(rows(23)), apiConnectionId: 'c1', apiWriteCode: BATCH_CODE, batchSize: 10, destinationName: 'Mock',
    });
    assert.strictEqual(out.success, true, out.message);
    assert.strictEqual(out.rowCount, 23);
    assert.deepStrictEqual(api.requests.map((r) => r.body.inputs.length), [10, 10, 3]);
    assert.strictEqual(api.requests[0].headers.authorization, 'Bearer secret-123');
    assert.match(out.message, /Sent 23 of 23 rows to Mock in 3 request batches/);
  } finally { await api.close(); }
});

test('rows the API rejects inside a successful response fail the node, with row numbers', async () => {
  const api = await mockApi((_req, body, n) => [207, { errors: n === 2 ? [{ index: 1, message: 'Property "nope" does not exist' }] : [] }]);
  try {
    initWith(api.url);
    const out = await writeRowsToApi({ pages: pagesOf(rows(20)), apiConnectionId: 'c1', apiWriteCode: BATCH_CODE, batchSize: 10, destinationName: 'Mock' });
    assert.strictEqual(out.success, false);
    assert.strictEqual(out.rowCount, 19);
    assert.strictEqual(out.failedCount, 1);
    assert.match(out.message, /rejected 1: row 12: Property "nope" does not exist/);
  } finally { await api.close(); }
});

test('a batch that fails stops the run and says how many rows were already sent', async () => {
  const api = await mockApi((_req, _body, n) => (n === 3 ? [400, { message: 'bad field' }] : [200, { errors: [] }]));
  try {
    initWith(api.url);
    const out = await writeRowsToApi({ pages: pagesOf(rows(50)), apiConnectionId: 'c1', apiWriteCode: BATCH_CODE, batchSize: 10, destinationName: 'Mock' });
    assert.strictEqual(out.success, false);
    assert.strictEqual(out.rowCount, 20);
    assert.strictEqual(api.requests.length, 3, 'no batch after the failed one is sent');
    assert.match(out.message, /stopped at batch 3 \(rows 21–30\): HTTP 400/);
    assert.match(out.message, /bad field/);
    assert.match(out.message, /20 rows were already sent and stay in Mock/);
    assert.doesNotMatch(out.message, /secret-123/);
  } finally { await api.close(); }
});

test('a 429 is retried after Retry-After; nothing else is', async () => {
  const api = await mockApi((_req, _body, n) => (n === 1 ? [429, { message: 'slow down' }, { 'Retry-After': '0' }] : [200, { errors: [] }]));
  try {
    initWith(api.url);
    const out = await writeRowsToApi({ pages: pagesOf(rows(5)), apiConnectionId: 'c1', apiWriteCode: BATCH_CODE, batchSize: 10 });
    assert.strictEqual(out.success, true, out.message);
    assert.strictEqual(api.requests.length, 2);
  } finally { await api.close(); }
});

test('state carries a lookup from one batch to the next within a run, and starts empty on the next run', async () => {
  const api = await mockApi(() => [200, {}]);
  try {
    initWith(api.url);
    const code = `async function sendBatch({ axios, rows, state }) {
      state.companies ??= {};
      for (const r of rows) {
        if (!state.companies[r.company]) {
          await axios.post('{{BASE_URL}}/companies', { name: r.company });
          state.companies[r.company] = true;
        }
        await axios.post('{{BASE_URL}}/contacts', { email: r.email });
      }
      return { sent: rows.length };
    }`;
    const contacts = [{ email: 'a', company: 'Northwind' }, { email: 'b', company: 'Contoso' }, { email: 'c', company: 'Northwind' }];
    const out = await writeRowsToApi({ pages: pagesOf(contacts), apiConnectionId: 'c1', apiWriteCode: code, batchSize: 1 });
    assert.strictEqual(out.success, true, out.message);
    assert.strictEqual(api.requests.filter((r) => r.url === '/companies').length, 2, 'Northwind is created once across batches');
    await writeRowsToApi({ pages: pagesOf(contacts), apiConnectionId: 'c1', apiWriteCode: code, batchSize: 1 });
    assert.strictEqual(api.requests.filter((r) => r.url === '/companies').length, 4, 'a new run starts with empty state');
  } finally { await api.close(); }
});

test('an empty source sends nothing and says so', async () => {
  const api = await mockApi(() => [200, {}]);
  try {
    initWith(api.url);
    const out = await writeRowsToApi({ pages: pagesOf([]), apiConnectionId: 'c1', apiWriteCode: BATCH_CODE, destinationName: 'Mock' });
    assert.strictEqual(out.success, true);
    assert.strictEqual(out.warning, true);
    assert.strictEqual(api.requests.length, 0);
  } finally { await api.close(); }
});

test('code that is not a function fails before anything is sent', async () => {
  initWith('http://127.0.0.1:9');
  const out = await writeRowsToApi({ pages: pagesOf(rows(2)), apiConnectionId: 'c1', apiWriteCode: '42' });
  assert.strictEqual(out.success, false);
  assert.match(out.message, /did not resolve to a function/);
});

test('the write reference lists each vendor\'s write endpoints, limits and credential placeholders', () => {
  const withWrites = presets.PRESETS.filter((p) => p.writes);
  assert.ok(withWrites.length >= 12);
  for (const p of withWrites) {
    for (const e of p.writes.endpoints) {
      assert.ok(e.method && e.path && e.label && Number.isInteger(e.batch) && e.batch > 0, `${p.id} ${e.path}`);
    }
  }
  const ref = presetReferenceForPlaceholders({ dbConfig: { presetId: 'hubspot', apiParamKeys: ['Access token'] } }, { mode: 'write' });
  assert.match(ref, /WRITING/);
  assert.match(ref, /batch\/upsert — Contacts — create or update by email; up to 100 records per request; matches existing records on email/);
  assert.match(ref, /Bearer \{\{ACCESS_TOKEN\}\}/);
  assert.doesNotMatch(ref, /Pagination:/);
});

test('a plan build pauses for approval of the send code, then saves exactly that code', async () => {
  const conn = { id: 'hs1', name: 'HubSpot', dbType: 'rest-api', dbCategory: 'API', dbConfig: { presetId: 'hubspot', baseUrl: 'https://api.hubapi.com', apiParamKeys: ['Access token'] } };
  const out = { action: 'create_plan', code: BATCH_CODE, explanation: 'Upserts contacts by email.', endpoint: 'POST {{BASE_URL}}/crm/v3/objects/contacts/batch/upsert', batchSize: 100, writeMode: 'upsert', fieldMapping: { email: 'email' } };
  const base = {
    conn, stepPrompt: 'send contacts', sourceColumns: [{ name: 'email' }], chat: [], nodeId: 'n1', helpers: {},
    resumedCalls: { 'output:apiWrite': out }, stage: 'output:apiWrite', clarificationKind: 'output.api_write',
  };
  await assert.rejects(
    workflowBuilder.buildApiWriteSpec({ ...base, apiFetchApproval: { route: 'plan', approvedCode: null } }),
    (err) => err.isApprovalNeeded && err.context.approval.kind === 'api_write' && err.context.approval.code === BATCH_CODE,
  );
  const spec = await workflowBuilder.buildApiWriteSpec({ ...base, apiFetchApproval: { route: 'plan', approvedCode: BATCH_CODE } });
  assert.strictEqual(spec.apiWriteCode, BATCH_CODE);
  assert.strictEqual(spec.apiWriteMode, 'upsert');
  assert.strictEqual(spec.apiBatchSize, 100);
  assert.strictEqual(spec.connectionId, 'hs1');
  assert.deepStrictEqual(spec.apiConnectionPublicConfig.apiParamKeys, ['Access token']);
  // A node built from its own chat is not paused: "Run this node" approves it.
  const direct = await workflowBuilder.buildApiWriteSpec({ ...base, apiFetchApproval: null });
  assert.strictEqual(direct.apiWriteCode, BATCH_CODE);
});

test('API connections are join destinations; cloud storage still is not', () => {
  assert.strictEqual(workflowBuilder.isApiConnection({ dbType: 'rest-api' }), true);
  assert.strictEqual(workflowBuilder.isJoinDestinationConnection({ dbType: 'rest-api', dbCategory: 'API' }), false,
    'the SQL target check stays strict — an API is routed through the local table');
  assert.strictEqual(workflowBuilder.isApiConnection({ dbType: 's3', dbCategory: 'CloudStorage' }), false);
});
