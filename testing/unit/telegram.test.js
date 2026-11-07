/**
 * Telegram bridge, end to end against a mock Bot API, with a stub chat
 * assistant — no Telegram account, bot token or AI provider needed.
 *
 *   node --test testing/unit/telegram.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createBotApi } = require('../../public/telegram/botApi');
const { createStore } = require('../../public/telegram/store');
const { TelegramBridge } = require('../../public/telegram/bridge');
const format = require('../../public/telegram/format');
const { createConversationRunner } = require('../../public/messaging/conversation');
const { chartConfig } = require('../../public/messaging/chartImage');

const TOKEN = '123456:TEST-token-not-real-0000000000000000';

// ── helpers ──────────────────────────────────────────────────────────────

// A mock Bot API: records every call, answers the ones the bridge makes.
async function mockTelegram() {
  const calls = [];
  const updates = [];
  let messageId = 100;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      const send = (body, status = 200) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (req.url.startsWith(`/file/bot${TOKEN}/`)) {
        res.writeHead(200);
        res.end('store,orders\nST-1,12\nST-2,30\n');
        return;
      }
      const m = req.url.match(new RegExp(`^/bot${TOKEN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/(\\w+)$`));
      if (!m) return send({ ok: false, description: 'Unauthorized' }, 401);
      const method = m[1];
      const isJson = (req.headers['content-type'] || '').includes('application/json');
      const body = isJson ? JSON.parse(raw.toString() || '{}') : { multipart: raw.toString('latin1') };
      calls.push({ method, body });
      switch (method) {
        case 'getMe': return send({ ok: true, result: { id: 1, is_bot: true, username: 'ternlux_test_bot', first_name: 'Ternlux' } });
        case 'getUpdates': return send({ ok: true, result: updates.splice(0) });
        case 'getFile': return send({ ok: true, result: { file_id: body.file_id, file_path: 'documents/file_1.csv' } });
        case 'sendMessage':
          if (body.parse_mode === 'HTML' && body.text.includes('<broken')) {
            return send({ ok: false, description: 'Bad Request: can\'t parse entities' }, 400);
          }
          return send({ ok: true, result: { message_id: ++messageId } });
        default: return send({ ok: true, result: true });
      }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    calls,
    updates,
    sent: (method) => calls.filter((c) => c.method === method),
    close: () => new Promise((r) => server.close(r)),
  };
}

// In-memory stand-in for the NeDB `chatSessions` collection.
function memoryDb() {
  const docs = [];
  const match = (q) => (d) => Object.entries(q).every(([k, v]) => d[k] === v);
  return {
    docs,
    findOneAsync: async (q) => docs.find(match(q)) || null,
    updateAsync: async (q, { $set }, { upsert } = {}) => {
      const i = docs.findIndex(match(q));
      if (i >= 0) docs[i] = { ...docs[i], ...structuredClone($set) };
      else if (upsert) docs.push(structuredClone($set));
    },
  };
}

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlx-tg-'));
  return createStore({ dir, encrypt: (s) => Buffer.from(s).toString('base64'), decrypt: (b) => Buffer.from(b, 'base64').toString() });
}

const user = { id: 42, is_bot: false, first_name: 'Ada', username: 'ada' };
const dm = (text, extra = {}) => ({ update_id: Math.floor(Math.random() * 1e6), message: { message_id: 1, from: user, chat: { id: 42, type: 'private' }, date: 0, text, ...extra } });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function bridgeWith(tg, { runner, importFile, builds = null, notes = [] } = {}) {
  const store = tempStore();
  const bridge = new TelegramBridge({
    api: createBotApi({ token: TOKEN, baseUrl: tg.baseUrl }),
    store,
    builds,
    runner: { note: async (id, msgs, patch, opts) => { notes.push({ id, msgs, patch, opts }); }, runTurn: async () => ({ answer: 'ok', visuals: [] }), ...(runner || {}) },
    importFile: importFile || (async () => { throw new Error('no import in this test'); }),
    saveUpload: async (chatId, name, buf) => {
      const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tlx-up-')), name);
      fs.writeFileSync(p, buf);
      return p;
    },
    log: { log() {}, warn() {}, error() {} },
  });
  return { bridge, store };
}

// ── format ───────────────────────────────────────────────────────────────

test('Markdown becomes Telegram HTML, with everything else escaped', () => {
  const html = format.markdownToTelegramHtml('# Totals\n**ST-1** has `12` orders & *more* <b>x</b>\n- one\n```sql\nSELECT 1 < 2\n```');
  assert.strictEqual(html, '<b>Totals</b>\n<b>ST-1</b> has <code>12</code> orders &amp; <i>more</i> &lt;b&gt;x&lt;/b&gt;\n• one\n<pre>SELECT 1 &lt; 2</pre>');
});

test('long answers split under the message limit without leaving a code block open', () => {
  const md = `${'word '.repeat(900)}\n\n\`\`\`\n${'line\n'.repeat(400)}\`\`\``;
  const chunks = format.chunkMarkdown(md, 3500);
  assert.ok(chunks.length > 1);
  for (const c of chunks) {
    assert.ok(format.markdownToTelegramHtml(c).length <= format.MAX_MESSAGE, 'chunk too long');
    assert.strictEqual((c.match(/```/g) || []).length % 2, 0, 'unbalanced fence');
  }
});

test('tables become CSV and a short monospace preview', () => {
  const v = { type: 'table', title: 'Orders', columns: ['store', 'note'], data: [{ store: 'ST-1', note: 'a, "b"' }, { store: 'ST-2', note: null }] };
  assert.strictEqual(format.tableToCsv(v), 'store,note\nST-1,"a, ""b"""\nST-2,');
  assert.match(format.tablePreview(v), /^store\s+note\n-----\s+-+\nST-1\s+a, "b"/);
});

test('chart configs carry the visual\'s points', () => {
  const cfg = chartConfig({ type: 'bar', title: 'Orders', data: [{ x: 'ST-1', y: 12 }, { x: 'ST-2', y: '30' }] });
  assert.strictEqual(cfg.type, 'bar');
  assert.deepStrictEqual(cfg.data.labels, ['ST-1', 'ST-2']);
  assert.deepStrictEqual(cfg.data.datasets[0].data, [12, 30]);
  assert.strictEqual(cfg.options.animation, false);
});

// ── store ────────────────────────────────────────────────────────────────

test('pairing codes work once, expire, and the token is stored encrypted', () => {
  const store = tempStore();
  store.setToken(TOKEN, { username: 'b' });
  assert.ok(!fs.readFileSync(store.file, 'utf8').includes(TOKEN), 'token must not be stored in clear');
  assert.strictEqual(store.getToken(), TOKEN);
  const { code } = store.newPairingCode(1000);
  assert.match(code, /^\d{6}$/);
  assert.strictEqual(store.checkPairingCode(code, 1000 + 60_000), true);
  assert.strictEqual(store.checkPairingCode(code, 1000 + 11 * 60_000), false, 'expired');
  store.addUser({ id: 42 });
  assert.strictEqual(store.checkPairingCode(code, 2000), false, 'used up by pairing');
  assert.strictEqual(store.isAllowed(42), true);
  store.removeUser(42);
  assert.strictEqual(store.isAllowed(42), false);
});

// ── conversation runner ──────────────────────────────────────────────────

test('runner: one turn is answered and saved as a chat session', async () => {
  const db = memoryDb();
  const seen = [];
  const chatAssistant = {
    runStep: async (args) => {
      seen.push(args);
      return { success: true, done: true, finalAnswer: 'ST-2 has the most orders.', chatTitle: 'Orders by store', visuals: [{ type: 'bar', data: [{ x: 'ST-2', y: 30 }] }], agentSource: 'main' };
    },
  };
  const runner = createConversationRunner({ chatAssistant, getDb: () => db, buildSkillHelpers: async () => ({}) });
  const out = await runner.runTurn({ convoId: 'c1', text: 'Which store has the most orders?', source: { platform: 'telegram' }, requestApproval: async () => false });
  assert.strictEqual(out.answer, 'ST-2 has the most orders.');
  assert.strictEqual(seen[0].isNewChat, true);
  assert.strictEqual(seen[0].targetNode, null);
  const saved = db.docs[0];
  assert.strictEqual(saved.title, 'Orders by store');
  assert.deepStrictEqual(saved.messages.map((m) => [m.role, m.kind || null]), [['user', null], ['assistant', 'final']]);
  assert.strictEqual(saved.source.platform, 'telegram');

  // The next turn carries the first as history.
  await runner.runTurn({ convoId: 'c1', text: 'And the least?', requestApproval: async () => false });
  assert.strictEqual(seen[1].isNewChat, false);
  assert.deepStrictEqual(seen[1].history.map((h) => h.role), ['user', 'assistant']);
});

test('runner: approved code runs and its result reaches the next step', async () => {
  const db = memoryDb();
  const steps = [
    { success: true, done: false, actions: [{ id: 'a1', tool: 'run_javascript', args: {}, ok: true, result: { ran: false } }],
      step: { index: 1, thought: '', actions: [{ id: 'a1', tool: 'run_javascript', args: {}, ok: true, result: { ran: false } }] },
      pendingApproval: { runToken: 'rt1', actionId: 'a1', transformFunction: 'async function f(){ return [1] }', explanation: 'Counts rows' } },
    { success: true, done: true, finalAnswer: 'There is 1 row.' },
  ];
  const calls = [];
  const chatAssistant = {
    runStep: async (args) => { calls.push(structuredClone(args.scratchpad)); return steps.shift(); },
    runApprovedJavascript: async ({ runToken }) => { assert.strictEqual(runToken, 'rt1'); return { rows: [{ n: 1 }] }; },
    discardPendingJavascript: () => assert.fail('must not discard approved code'),
  };
  let asked = null;
  const runner = createConversationRunner({ chatAssistant, getDb: () => db, buildSkillHelpers: async () => ({}) });
  const out = await runner.runTurn({ convoId: 'c2', text: 'count', requestApproval: async (req) => { asked = req; return true; } });
  assert.strictEqual(asked.code, 'async function f(){ return [1] }');
  assert.strictEqual(out.answer, 'There is 1 row.');
  assert.deepStrictEqual(calls[1][0].actions[0].result, { rows: [{ n: 1 }] }, 'approved result replayed to the model');
  assert.strictEqual(db.docs[0].messages.find((m) => m.kind === 'step').approval.state, 'approved');
});

test('runner: declined code is discarded and the turn ends', async () => {
  const db = memoryDb();
  let discarded = null;
  const chatAssistant = {
    runStep: async () => ({ success: true, done: false, actions: [{ tool: 'run_javascript' }], step: { index: 1, actions: [{ tool: 'run_javascript' }] }, pendingApproval: { runToken: 'rt2', transformFunction: 'x' } }),
    discardPendingJavascript: (t) => { discarded = t; },
    runApprovedJavascript: () => assert.fail('must not run declined code'),
  };
  const runner = createConversationRunner({ chatAssistant, getDb: () => db, buildSkillHelpers: async () => ({}) });
  const out = await runner.runTurn({ convoId: 'c3', text: 'x', requestApproval: async () => false });
  assert.strictEqual(discarded, 'rt2');
  assert.match(out.answer, /Code not run/);
});

test('runner: a deferred plan_workflow_build restarts the loop, as the chat window does', async () => {
  const db = memoryDb();
  const seen = [];
  const steps = [
    { success: true, done: true, finalAnswer: 'Looked it up.', pendingPlanWorkflowBuild: { args: { request: 'build it' } } },
    { success: true, done: true, finalAnswer: 'Here is the plan.', workflowPlan: { steps: [{ label: 'Read orders' }] } },
  ];
  const chatAssistant = { runStep: async (a) => { seen.push(a.triggerPlanWorkflowBuild); return steps.shift(); } };
  const runner = createConversationRunner({ chatAssistant, getDb: () => db, buildSkillHelpers: async () => ({}) });
  const out = await runner.runTurn({ convoId: 'c4', text: 'build', requestApproval: async () => false });
  assert.deepStrictEqual(seen, [null, { request: 'build it' }]);
  assert.deepStrictEqual(out.workflowPlan, { steps: [{ label: 'Read orders' }] });
});

// ── bridge against the mock Bot API ─────────────────────────────────────

test('bridge: strangers are refused; a valid code pairs; groups are refused', async () => {
  const tg = await mockTelegram();
  try {
    const { bridge, store } = bridgeWith(tg);
    await bridge.handleUpdate(dm('hello'));
    assert.match(tg.sent('sendMessage').at(-1).body.text, /This bot is private/);
    await bridge.handleUpdate(dm('/pair 000000'));
    assert.match(tg.sent('sendMessage').at(-1).body.text, /This bot is private/, 'wrong code');
    const { code } = store.newPairingCode();
    await bridge.handleUpdate(dm(`/start ${code}`));
    assert.match(tg.sent('sendMessage').at(-1).body.text, /^Paired\./);
    assert.strictEqual(store.isAllowed(42), true);
    await bridge.handleUpdate({ update_id: 9, message: { message_id: 2, from: user, chat: { id: -5, type: 'group' }, text: 'hi' } });
    assert.match(tg.sent('sendMessage').at(-1).body.text, /only work in a direct message/);
  } finally {
    await tg.close();
  }
});

test('bridge: a question is answered, with a table as preview + CSV and /new starting over', async () => {
  const tg = await mockTelegram();
  try {
    const turns = [];
    const runner = { runTurn: async (t) => { turns.push(t); return { answer: '**ST-2** leads.', visuals: [{ type: 'table', title: 'Orders', columns: ['store', 'orders'], data: [{ store: 'ST-2', orders: 30 }] }] }; } };
    const { bridge, store } = bridgeWith(tg, { runner });
    store.addUser({ id: 42 });
    await bridge.handleUpdate(dm('Orders by store?'));
    const msgs = tg.sent('sendMessage').map((c) => c.body);
    assert.strictEqual(msgs[0].text, '<b>ST-2</b> leads.');
    assert.strictEqual(msgs[0].parse_mode, 'HTML');
    assert.match(msgs[1].text, /<pre>store\s+orders/);
    const doc = tg.sent('sendDocument')[0];
    assert.match(doc.body.multipart, /filename="Orders\.csv"/);
    assert.match(doc.body.multipart, /store,orders\r?\nST-2,30/);
    const first = turns[0].convoId;
    await bridge.handleUpdate(dm('/new'));
    await bridge.handleUpdate(dm('again'));
    assert.notStrictEqual(turns[1].convoId, first, '/new starts a new conversation');
    assert.strictEqual(turns[1].source.platform, 'telegram');
  } finally {
    await tg.close();
  }
});

test('bridge: approval buttons — only the asker can press them', async () => {
  const tg = await mockTelegram();
  try {
    let decision = null;
    const runner = { runTurn: async (t) => { decision = await t.requestApproval({ code: 'return rows', explanation: 'Counts rows' }); return { answer: decision ? 'ran' : 'not run' }; } };
    const { bridge, store } = bridgeWith(tg, { runner });
    store.addUser({ id: 42 });
    const turn = bridge.handleUpdate(dm('count rows'));
    await wait(100);
    const ask = tg.sent('sendMessage').find((c) => c.body.reply_markup);
    // Description first; the code collapsed behind a tap.
    assert.match(ask.body.text, /^<b>Approve before this runs<\/b>\nCounts rows\n<i>Code — tap to expand<\/i>\n<blockquote expandable><code>return rows<\/code><\/blockquote>/);
    const yes = ask.body.reply_markup.inline_keyboard[0][0].callback_data;
    await bridge.handleUpdate({ update_id: 2, callback_query: { id: 'q1', from: { id: 99 }, data: yes } });
    assert.match(tg.sent('answerCallbackQuery').at(-1).body.text, /Only the person who asked/);
    assert.strictEqual(decision, null);
    await bridge.handleUpdate({ update_id: 3, callback_query: { id: 'q2', from: { id: 42 }, data: yes } });
    await turn;
    assert.strictEqual(decision, true);
    assert.match(tg.sent('editMessageText').at(-1).body.text, /Approved — running\./);
    assert.strictEqual(tg.sent('sendMessage').at(-1).body.text, 'ran');
  } finally {
    await tg.close();
  }
});

test('bridge: a CSV sent to the bot is downloaded and added as a connection', async () => {
  const tg = await mockTelegram();
  try {
    let imported = null;
    const importFile = async (localPath, opts) => {
      imported = { localPath, opts, content: fs.readFileSync(localPath, 'utf8') };
      return { connection: { name: opts.name }, tables: [{ name: 'orders', columns: 2 }] };
    };
    const { bridge, store } = bridgeWith(tg, { importFile });
    store.addUser({ id: 42 });
    await bridge.handleUpdate(dm(undefined, { caption: 'Store orders', document: { file_id: 'F1', file_name: 'orders.csv', file_size: 40 } }));
    assert.strictEqual(imported.opts.name, 'Store orders');
    assert.strictEqual(imported.opts.fileType, 'spreadsheet');
    assert.strictEqual(path.basename(imported.localPath), 'orders.csv');
    assert.match(imported.content, /^store,orders/);
    assert.match(tg.sent('sendMessage').at(-1).body.text, /Added <b>Store orders<\/b> as a connection\.\n• <code>orders<\/code> — 2 columns/);

    await bridge.handleUpdate(dm(undefined, { document: { file_id: 'F2', file_name: 'notes.pdf', file_size: 10 } }));
    assert.match(tg.sent('sendMessage').at(-1).body.text, /can't add notes\.pdf/);
    await bridge.handleUpdate(dm(undefined, { document: { file_id: 'F3', file_name: 'big.csv', file_size: 30 * 1024 * 1024 } }));
    assert.match(tg.sent('sendMessage').at(-1).body.text, /over 20 MB/);
  } finally {
    await tg.close();
  }
});

test('bridge: Telegram rejecting the HTML falls back to plain text', async () => {
  const tg = await mockTelegram();
  try {
    const { bridge } = bridgeWith(tg);
    await bridge.reply(42, '<broken & ok', { html: true });
    const last = tg.sent('sendMessage').at(-1).body;
    assert.strictEqual(last.parse_mode, undefined);
    assert.strictEqual(last.text, '<broken & ok');
  } finally {
    await tg.close();
  }
});

test('bridge: polling stores the offset so a restart does not replay messages', async () => {
  const tg = await mockTelegram();
  try {
    const { bridge, store } = bridgeWith(tg);
    tg.updates.push({ ...dm('hi'), update_id: 500 });
    bridge.start();
    await wait(150);
    bridge.stop();
    assert.strictEqual(store.get().offset, 501);
    assert.strictEqual(tg.sent('getUpdates')[0].body.offset, 0);
  } finally {
    await tg.close();
  }
});

test('runner: every save is announced, so an open chat panel can show it live', async () => {
  const db = memoryDb();
  const saved = [];
  const chatAssistant = { runStep: async () => ({ success: true, done: true, finalAnswer: 'hi' }) };
  const runner = createConversationRunner({
    chatAssistant, getDb: () => db, buildSkillHelpers: async () => ({}), onSaved: (id) => saved.push(id),
  });
  await runner.runTurn({ convoId: 'c9', text: 'hello', source: { platform: 'telegram' }, requestApproval: async () => false });
  assert.ok(saved.length >= 2, 'saved when the question arrives and again with the answer');
  assert.ok(saved.every((id) => id === 'c9'));
  assert.strictEqual(db.docs[0].source.platform, 'telegram');
});

// ── workflow plans built from Telegram ───────────────────────────────────

const { createWorkflowBuildRunner } = require('../../public/messaging/workflowBuild');

// executeBuild stand-in: each call takes the next scripted outcome.
function scriptedBuilds(script) {
  const seen = [];
  const runner = createWorkflowBuildRunner({
    workflowBuilder: { executeBuild: async ({ plan }) => { seen.push(structuredClone(plan)); const next = script.shift(); if (next instanceof Error) throw next; return next; } },
    getDb: () => ({ findOneAsync: async () => null }),
    buildSkillHelpers: async () => ({}),
  });
  return { runner, seen };
}
const pause = (props) => Object.assign(new Error('paused'), { isClarificationNeeded: true, ...props });
const built = { workflowId: 'wf1', workflowName: 'Headcount', nodes: [1, 2, 3], edges: [1, 2], warnings: [] };
const planTurn = (plan) => ({ runTurn: async () => ({ answer: 'Here is the plan.', workflowPlan: plan }) });

test('plans: Build runs it, an API-call approval and a question are answered in Telegram', async () => {
  const tg = await mockTelegram();
  try {
    const { runner: builds, seen } = scriptedBuilds([
      pause({ isApprovalNeeded: true, question: 'Run the API call?', stepIndex: 0, builtSteps: { 0: 'x' }, buildWorkflowId: 'wf1',
        context: { approval: { kind: 'api_fetch', code: 'fetch(...)', explanation: 'Calls the API', resumedCalls: { a: 1 } } } }),
      pause({ question: 'Which table name?', stepIndex: 1 }),
      built,
    ]);
    const notes = [];
    const { bridge, store } = bridgeWith(tg, { runner: planTurn({ mode: 'new', name: 'Headcount', steps: [
      { stepType: 'dataSource', label: 'Read employees', prompt: 'All rows from employees.' },
      { stepType: 'transformer', label: 'Count by city', prompt: 'Count employees per city.', sources: [0] },
    ] }), builds, notes });
    store.addUser({ id: 42 });
    await bridge.handleUpdate(dm('Build a headcount workflow'));
    const offer = tg.sent('sendMessage').find((c) => c.body.reply_markup && /<b>Headcount<\/b>/.test(c.body.text));
    assert.strictEqual(offer.body.text, [
      '<b>Headcount</b> · 2 steps', '',
      '🟦 <b>1. Read employees</b>  <code>DATA SOURCE</code>', 'All rows from employees.', '',
      '🟪 <b>2. Count by city</b>  <code>TRANSFORMER</code> ← 1', 'Count employees per city.',
    ].join('\n'));
    const buildBtn = offer.body.reply_markup.inline_keyboard[0][0].callback_data;

    const building = bridge.handleUpdate({ update_id: 5, callback_query: { id: 'p1', from: { id: 42 }, data: buildBtn } });
    await wait(100);
    const ask = tg.sent('sendMessage').filter((c) => c.body.reply_markup).at(-1);
    assert.match(ask.body.text, /^<b>Run this API call to build the workflow\?<\/b>\nCalls the API/);
    await bridge.handleUpdate({ update_id: 6, callback_query: { id: 'p2', from: { id: 42 }, data: ask.body.reply_markup.inline_keyboard[0][0].callback_data } });
    await building;
    assert.match(tg.sent('sendMessage').at(-1).body.text, /Which table name\?[\s\S]*\/cancel/);
    // The second pass resumed with the approval and what was already built.
    assert.deepStrictEqual(seen[1].apiFetchApprovals, { 0: 'fetch(...)' });
    assert.deepStrictEqual(seen[1].builtSteps, { 0: 'x' });

    await bridge.handleUpdate(dm('headcount_by_city'));
    assert.deepStrictEqual(seen[2].clarifications, [{ question: 'Which table name?', answer: 'headcount_by_city', stepIndex: 1 }]);
    assert.match(tg.sent('sendMessage').at(-1).body.text, /^✓ Built "Headcount" — 3 nodes, 2 edges\./);
    assert.deepStrictEqual(notes.at(-1).patch, { agentMode: 'main', workflowSession: null, pendingBuild: null });
    // The app's plan card follows along: building, waiting on the question,
    // building again once answered, built.
    const statuses = notes.map((n) => n.opts?.planStatus?.message).filter(Boolean);
    assert.deepStrictEqual(statuses.slice(0, 3), [
      'Building workflow… (from Telegram)',
      'Waiting for your answer in Telegram: Which table name?',
      'Building workflow… (from Telegram)',
    ]);
    assert.match(notes.at(-1).opts.planStatus.message, /^Built "Headcount" — 3 nodes, 2 edges\. \(built from Telegram\)$/);
  } finally {
    await tg.close();
  }
});

test('plans: a declined approval stops the build; /cancel drops a waiting question', async () => {
  const tg = await mockTelegram();
  try {
    const { runner: builds, seen } = scriptedBuilds([
      pause({ isApprovalNeeded: true, question: 'Recreate?', stepIndex: 2, context: { approval: { kind: 'target_rebuild', table: 'sales', code: 'DROP TABLE sales' } } }),
      pause({ question: 'Which column?', stepIndex: 0 }),
    ]);
    const { bridge, store } = bridgeWith(tg, { runner: planTurn({ mode: 'new', steps: [{ label: 'A' }] }), builds });
    store.addUser({ id: 42 });
    await bridge.handleUpdate(dm('build'));
    let btn = tg.sent('sendMessage').filter((c) => c.body.reply_markup).at(-1).body.reply_markup.inline_keyboard[0][0].callback_data;
    const b1 = bridge.handleUpdate({ update_id: 7, callback_query: { id: 'q', from: { id: 42 }, data: btn } });
    await wait(100);
    const ask = tg.sent('sendMessage').filter((c) => c.body.reply_markup).at(-1);
    assert.match(ask.body.text, /Recreate sales\?/);
    await bridge.handleUpdate({ update_id: 8, callback_query: { id: 'r', from: { id: 42 }, data: ask.body.reply_markup.inline_keyboard[0][1].callback_data } });
    await b1;
    assert.match(tg.sent('sendMessage').at(-1).body.text, /nothing was saved, and sales was left as it is/);
    assert.strictEqual(seen.length, 1, 'declined — no second pass');

    await bridge.handleUpdate(dm('build again'));
    btn = tg.sent('sendMessage').filter((c) => c.body.reply_markup).at(-1).body.reply_markup.inline_keyboard[0][0].callback_data;
    await bridge.handleUpdate({ update_id: 9, callback_query: { id: 's', from: { id: 42 }, data: btn } });
    assert.match(tg.sent('sendMessage').at(-1).body.text, /Which column\?/);
    await bridge.handleUpdate(dm('/cancel'));
    assert.match(tg.sent('sendMessage').at(-1).body.text, /Stopped the workflow build/);
  } finally {
    await tg.close();
  }
});

test('plans: changing an existing workflow is left to the app; only the asker can press Build', async () => {
  const tg = await mockTelegram();
  try {
    const { runner: builds } = scriptedBuilds([built]);
    const { bridge, store } = bridgeWith(tg, { runner: planTurn({ mode: 'modify', workflowId: 'w9', steps: [{ label: 'A' }] }), builds });
    store.addUser({ id: 42 });
    await bridge.handleUpdate(dm('change my workflow'));
    const last = tg.sent('sendMessage').at(-1).body;
    assert.strictEqual(last.reply_markup, undefined);
    assert.match(last.text, /changes an existing workflow, so build it in Ternlux/);

    const { bridge: b2, store: s2 } = bridgeWith(tg, { runner: planTurn({ mode: 'new', steps: [{ label: 'A' }] }), builds });
    s2.addUser({ id: 42 });
    await b2.handleUpdate(dm('new one'));
    const btn = tg.sent('sendMessage').filter((c) => c.body.reply_markup).at(-1).body.reply_markup.inline_keyboard[0][0].callback_data;
    await b2.handleUpdate({ update_id: 10, callback_query: { id: 't', from: { id: 7 }, data: btn } });
    assert.match(tg.sent('answerCallbackQuery').at(-1).body.text, /Only the person who asked can build this/);
  } finally {
    await tg.close();
  }
});


test('plan cards: a kept step, a modified step and deleted nodes read like the app', () => {
  const { planToHtml } = require('../../public/telegram/bridge');
  const html = planToHtml({
    mode: 'modify', nodeLabels: { n1: 'orders', n2: 'old <calc>' }, deletedNodes: ['n2'],
    steps: ['n1', { stepType: 'output', existingNodeId: 'n3', label: 'x', prompt: 'p'.repeat(500), sources: ['n1'] }],
  });
  assert.match(html, /^<b>Modify workflow<\/b> · 2 steps/);
  assert.match(html, /⬜ <b>1\. Keep orders<\/b>  <code>KEEP<\/code>/);
  assert.match(html, /🟥 <b>2\. Modify n3<\/b>  <code>OUTPUT<\/code> ← 1\np{10}/);
  assert.match(html, /p{399}…/, 'long descriptions are cut');
  assert.match(html, /🗑 Deletes: old &lt;calc&gt;/);
});

test('runner.note sets the plan card status on the message carrying the plan', async () => {
  const db = memoryDb();
  const chatAssistant = { runStep: async () => ({ success: true, done: true, finalAnswer: 'Plan', workflowPlan: { steps: [] } }) };
  const runner = createConversationRunner({ chatAssistant, getDb: () => db, buildSkillHelpers: async () => ({}) });
  await runner.runTurn({ convoId: 'p1', text: 'build', requestApproval: async () => false });
  await runner.note('p1', [{ role: 'assistant', kind: 'final', text: 'done' }], {}, { planStatus: { kind: 'success', message: 'Built' } });
  const msgs = db.docs[0].messages;
  assert.deepStrictEqual(msgs.find((m) => m.workflowPlan).planStatus, { kind: 'success', message: 'Built' });
  assert.strictEqual(msgs.at(-1).text, 'done');
});

// ── /cancel ──────────────────────────────────────────────────────────────

test('runner: a cancelled turn drops the step that was in flight and stops', async () => {
  const db = memoryDb();
  let cancelled = false;
  let calls = 0;
  const chatAssistant = {
    runStep: async () => { calls++; cancelled = true; return { success: true, done: true, finalAnswer: 'late answer' }; },
  };
  const runner = createConversationRunner({ chatAssistant, getDb: () => db, buildSkillHelpers: async () => ({}) });
  const out = await runner.runTurn({ convoId: 'x1', text: 'q', requestApproval: async () => false, isCancelled: () => cancelled });
  assert.strictEqual(out.cancelled, true);
  assert.strictEqual(out.answer, null, 'the late answer is dropped');
  assert.strictEqual(calls, 1);
  assert.strictEqual(db.docs[0].messages.at(-1).text, '_Stopped by user._');
});

test('/cancel stops an answer in progress', async () => {
  const tg = await mockTelegram();
  try {
    let release;
    const gate = new Promise((r) => { release = r; });
    const runner = { runTurn: async (t) => { await gate; return t.isCancelled() ? { cancelled: true } : { answer: 'done' }; } };
    const { bridge, store } = bridgeWith(tg, { runner });
    store.addUser({ id: 42 });
    const turn = bridge.handleUpdate(dm('slow question'));
    await wait(50);
    await bridge.handleUpdate(dm('another'));
    assert.match(tg.sent('sendMessage').at(-1).body.text, /Still working[\s\S]*\/cancel/);
    await bridge.handleUpdate(dm('/cancel'));
    assert.match(tg.sent('sendMessage').at(-1).body.text, /^Stopping — the step already running finishes first/);
    release();
    await turn;
    assert.strictEqual(tg.sent('sendMessage').at(-1).body.text, 'Stopped.');
    await bridge.handleUpdate(dm('/cancel'));
    assert.match(tg.sent('sendMessage').at(-1).body.text, /^Nothing to cancel/);
  } finally {
    await tg.close();
  }
});

test('/cancel declines an approval that is waiting on a button', async () => {
  const tg = await mockTelegram();
  try {
    let decision;
    const runner = { runTurn: async (t) => { decision = await t.requestApproval({ code: 'x', explanation: 'y' }); return { cancelled: t.isCancelled() }; } };
    const { bridge, store } = bridgeWith(tg, { runner });
    store.addUser({ id: 42 });
    const turn = bridge.handleUpdate(dm('run code'));
    await wait(80);
    await bridge.handleUpdate(dm('/cancel'));
    await turn;
    assert.strictEqual(decision, false);
    assert.match(tg.sent('editMessageText').at(-1).body.text, /Cancelled\./);
  } finally {
    await tg.close();
  }
});

test('/cancel stops a workflow build after the pass in progress', async () => {
  const tg = await mockTelegram();
  try {
    let release;
    const gate = new Promise((r) => { release = r; });
    const passes = [];
    const builds = createWorkflowBuildRunner({
      workflowBuilder: { executeBuild: async () => { passes.push(1); await gate; throw pause({ question: 'More?', stepIndex: 0 }); } },
      getDb: () => ({ findOneAsync: async () => null }), buildSkillHelpers: async () => ({}),
    });
    const notes = [];
    const { bridge, store } = bridgeWith(tg, { runner: planTurn({ mode: 'new', steps: [{ stepType: 'join', label: 'J' }] }), builds, notes });
    store.addUser({ id: 42 });
    await bridge.handleUpdate(dm('build it'));
    const btn = tg.sent('sendMessage').filter((c) => c.body.reply_markup).at(-1).body.reply_markup.inline_keyboard[0][0].callback_data;
    const building = bridge.handleUpdate({ update_id: 11, callback_query: { id: 'b', from: { id: 42 }, data: btn } });
    await wait(50);
    await bridge.handleUpdate(dm('/cancel'));
    assert.match(tg.sent('sendMessage').at(-1).body.text, /^Stopping the build/);
    release();
    await building;
    assert.strictEqual(passes.length, 1);
    assert.strictEqual(tg.sent('sendMessage').at(-1).body.text, 'Build stopped. Nothing more was built.');
    assert.strictEqual(notes.at(-1).opts.planStatus.kind, 'cancelled');
  } finally {
    await tg.close();
  }
});
