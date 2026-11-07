/**
 * Slack bridge, end to end against a mock Slack Web API and a local WebSocket
 * server standing in for Socket Mode, with a stub chat assistant — no Slack
 * workspace, tokens or AI provider needed.
 *
 *   node --test testing/unit/slack.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { WebSocketServer } = require('ws');

const { createSlackApi } = require('../../public/slack/webApi');
const { SocketModeClient } = require('../../public/slack/socketMode');
const { SlackAdapter } = require('../../public/slack/adapter');
const { markdownToMrkdwn, renderLines } = require('../../public/slack/format');
const { buildManifest, cleanName, computerName, defaultBotName, botHandle, BOT_SCOPES } = require('../../public/slack/manifest');
const { MessagingBridge } = require('../../public/messaging/bridge');
const { createStore } = require('../../public/telegram/store');

const BOT = 'xoxb-test-bot-token-0000000000';
const APP = 'xapp-test-app-token-0000000000';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ── mock Slack: Web API over HTTP + Socket Mode over WebSocket ───────────

async function mockSlack() {
  const calls = [];
  const acks = [];
  let ts = 1000;
  let opens = 0;
  const sockets = [];
  const wss = new WebSocketServer({ port: 0 });
  wss.on('connection', (ws) => {
    sockets.push(ws);
    ws.on('message', (m) => acks.push(JSON.parse(String(m)).envelope_id));
    ws.send(JSON.stringify({ type: 'hello' }));
  });
  await new Promise((r) => wss.on('listening', r));
  const wsUrl = `ws://127.0.0.1:${wss.address().port}`;

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString();
      const json = (body, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
      if (req.url.startsWith('/files-private/')) {
        if (req.headers.authorization !== `Bearer ${BOT}`) return json({}, 403);
        res.writeHead(200, { 'Content-Type': 'text/csv' });
        return res.end('store,orders\nST-1,12\n');
      }
      if (req.url.startsWith('/upload/')) {
        calls.push({ method: 'upload', body: raw, auth: req.headers.authorization });
        res.writeHead(200);
        return res.end('OK');
      }
      const method = req.url.replace(/^\/api\//, '');
      const body = (req.headers['content-type'] || '').includes('json') ? JSON.parse(raw || '{}') : Object.fromEntries(new URLSearchParams(raw));
      calls.push({ method, body, auth: req.headers.authorization });
      switch (method) {
        case 'auth.test': return json({ ok: true, team: 'Acme', user: 'ternlux_mbp', user_id: 'UBOT', bot_id: 'BBOT', team_id: 'T1' });
        case 'apps.connections.open':
          opens++;
          return req.headers.authorization === `Bearer ${APP}` ? json({ ok: true, url: wsUrl }) : json({ ok: false, error: 'invalid_auth' });
        case 'users.info': return json({ ok: true, user: { name: 'ada', profile: { real_name: 'Ada Lovelace' } } });
        case 'chat.postMessage': return json({ ok: true, ts: String(++ts) });
        case 'files.getUploadURLExternal': return json({ ok: true, upload_url: `http://127.0.0.1:${server.address().port}/upload/F${ts}`, file_id: `F${ts}` });
        default: return json({ ok: true });
      }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  let envelope = 0;
  return {
    apiBase: `${base}/api`,
    fileUrl: (name) => `${base}/files-private/${name}`,
    calls,
    acks,
    opens: () => opens,
    sent: (method) => calls.filter((c) => c.method === method),
    // Push an envelope down the newest socket, as Slack would.
    push: (type, payload, extra = {}) => {
      const id = `env${++envelope}`;
      sockets.at(-1).send(JSON.stringify({ envelope_id: id, type, payload, ...extra }));
      return id;
    },
    disconnect: () => sockets.at(-1).send(JSON.stringify({ type: 'disconnect', reason: 'refresh_requested' })),
    close: async () => {
      for (const s of sockets) s.terminate();
      await new Promise((r) => wss.close(r));
      await new Promise((r) => server.close(r));
    },
  };
}

function memoryStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlx-slack-'));
  return createStore({ dir, fileName: 'slack.json', encrypt: (s) => `enc:${s}`, decrypt: (s) => s.slice(4) });
}

async function startBridge(slack, { runner, importFile, builds = null } = {}) {
  const api = createSlackApi({ botToken: BOT, appToken: APP, baseUrl: slack.apiBase });
  const socket = new SocketModeClient({ openUrl: async () => (await api.openConnection()).url, log: { warn() {} } });
  const adapter = new SlackAdapter({ api, socket, log: { warn() {}, error() {}, log() {} } });
  const store = memoryStore();
  const notes = [];
  const core = new MessagingBridge({
    adapter,
    store,
    builds,
    runner: { note: async (...a) => notes.push(a), runTurn: async () => ({ answer: 'ok' }), ...(runner || {}) },
    importFile: importFile || (async () => { throw new Error('no import'); }),
    saveUpload: async (chatId, name, buf) => {
      const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tlx-up-')), name);
      fs.writeFileSync(p, buf);
      return p;
    },
    log: { log() {}, warn() {}, error() {} },
  });
  adapter.start((e) => core.handle(e), { botUserId: 'UBOT' });
  for (let i = 0; i < 50 && !socket.connected; i++) await wait(20);
  return { adapter, socket, store, core, notes };
}

const dmEvent = (text, extra = {}) => ({
  event_id: `Ev${Math.random()}`,
  event: { type: 'message', channel_type: 'im', channel: 'D1', user: 'U42', text, ts: `${Date.now()}.0001`, ...extra },
});

// ── format and manifest ──────────────────────────────────────────────────

test('Markdown becomes Slack mrkdwn', () => {
  assert.strictEqual(
    markdownToMrkdwn('# Top\n**ST-2** has *many* orders & `a<b` — [docs](https://x.io)\n- one\n```sql\nSELECT 1 < 2\n```'),
    '*Top*\n*ST-2* has _many_ orders &amp; `a&lt;b` — <https://x.io|docs>\n• one\n```SELECT 1 &lt; 2```',
  );
  assert.strictEqual(renderLines([['Added ', { b: 'Sales' }, ' ', { code: 'orders' }], [{ i: 'note <x>' }]]), 'Added *Sales* `orders`\n_note &lt;x&gt;_');
});

test('the manifest names the bot after the computer and turns on Socket Mode', () => {
  assert.strictEqual(computerName('Alexs-MacBook-Air.local'), 'Alexs MacBook Air');
  assert.strictEqual(defaultBotName('Alexs-MacBook-Air.local'), 'Ternlux · Alexs MacBook Air');
  assert.strictEqual(cleanName('  x'.repeat(40)).length, 35);
  const m = buildManifest('Ternlux · Office Mac');
  assert.strictEqual(m.display_information.name, 'Ternlux · Office Mac');
  // The app keeps its readable name; the bot user gets a Slack-legal handle.
  assert.strictEqual(m.features.bot_user.display_name, 'ternlux-office-mac');
  assert.strictEqual(m.settings.socket_mode_enabled, true);
  assert.strictEqual(m.settings.interactivity.is_enabled, true);
  assert.deepStrictEqual(m.settings.event_subscriptions.bot_events, ['message.im', 'app_mention']);
  assert.deepStrictEqual(m.oauth_config.scopes.bot, BOT_SCOPES);
  assert.ok(m.features.app_home.messages_tab_enabled && !m.features.app_home.messages_tab_read_only_enabled);
});

test('bot handles follow Slack\'s rules: a-z 0-9 - _ . and under 22 characters', () => {
  assert.strictEqual(botHandle('Ternlux · MacBook Air 13'), 'ternlux-macbookair13');
  assert.strictEqual(botHandle('Ternlux · Office Mac'), 'ternlux-office-mac');
  assert.strictEqual(botHandle('Sales Laptop'), 'ternlux-sales-laptop');
  assert.strictEqual(botHandle('Ternlux · Alexs MacBook Air Pro Max'), 'ternlux-alexsmacbooka');
  assert.strictEqual(botHandle('Ternlux · Café Büro'), 'ternlux-cafe-buro');
  assert.strictEqual(botHandle('Ternlux ·'), 'ternlux');
  for (const n of ['Ternlux · MacBook Air 13', 'A · B', '日本語 Mac', 'x'.repeat(60)]) {
    const h = botHandle(n);
    assert.match(h, /^[a-z0-9._-]{1,21}$/, `${n} → ${h}`);
  }
});

test('commands are whole-message words; questions that start with one are not commands', () => {
  const a = new SlackAdapter({ api: {}, socket: {} });
  assert.deepStrictEqual(a.parseCommand('cancel'), { name: 'cancel', arg: '' });
  assert.deepStrictEqual(a.parseCommand(' pair 123456 '), { name: 'pair', arg: '123456' });
  assert.deepStrictEqual(a.parseCommand('New'), { name: 'new', arg: '' });
  assert.strictEqual(a.parseCommand('new customers last month?'), null);
  assert.strictEqual(a.parseCommand('help me chart orders'), null);
});

// ── end to end ───────────────────────────────────────────────────────────

test('Socket Mode: envelopes are acknowledged, retries dropped, refreshes reconnect', async () => {
  const slack = await mockSlack();
  const { adapter } = await startBridge(slack);
  try {
    const ev = dmEvent('hello');
    const id1 = slack.push('events_api', ev);
    const id2 = slack.push('events_api', ev, { retry_attempt: 1 }); // Slack retrying the same event
    await wait(150);
    assert.ok(slack.acks.includes(id1) && slack.acks.includes(id2), 'both envelopes acknowledged');
    assert.strictEqual(slack.sent('chat.postMessage').length, 1, 'the retry is not answered twice');
    slack.disconnect();
    await wait(200);
    assert.strictEqual(slack.opens(), 2, 'a fresh connection was opened');
    assert.strictEqual(adapter.socket.connected, true);
  } finally {
    adapter.stop();
    await slack.close();
  }
});

test('pairing, a question with the working reaction, and a channel mention', async () => {
  const slack = await mockSlack();
  const { adapter, store } = await startBridge(slack, {
    runner: { runTurn: async () => ({ answer: '**ST-2** leads.', visuals: [{ type: 'table', title: 'Orders', columns: ['store', 'orders'], data: [{ store: 'ST-2', orders: 30 }] }] }) },
  });
  try {
    slack.push('events_api', dmEvent('hello'));
    await wait(100);
    assert.match(slack.sent('chat.postMessage').at(-1).body.text, /This bot is private[\s\S]*“pair” 123456/);
    const { code } = store.newPairingCode();
    slack.push('events_api', dmEvent(`pair ${code}`));
    await wait(100);
    assert.match(slack.sent('chat.postMessage').at(-1).body.text, /^Paired\. \*Ternlux\*/);
    assert.deepStrictEqual(store.users()[0].name, 'Ada Lovelace');

    slack.push('events_api', dmEvent('Orders by store?', { ts: '111.222' }));
    await wait(200);
    const posts = slack.sent('chat.postMessage').map((c) => c.body.text);
    assert.ok(posts.includes('*ST-2* leads.'));
    assert.ok(posts.some((t) => /^```store\s+orders/.test(t)), 'table preview');
    assert.deepStrictEqual(slack.sent('reactions.add')[0].body, { channel: 'D1', timestamp: '111.222', name: 'hourglass_flowing_sand' });
    assert.strictEqual(slack.sent('reactions.remove').length, 1);
    // The CSV went through the two-step upload.
    assert.strictEqual(slack.sent('files.getUploadURLExternal')[0].body.filename, 'Orders.csv');
    assert.match(slack.sent('upload')[0].body, /^store,orders\nST-2,30/);
    assert.strictEqual(slack.sent('files.completeUploadExternal')[0].body.channel_id, 'D1');

    slack.push('events_api', { event_id: 'EvM', event: { type: 'app_mention', channel: 'C9', user: 'U42', text: '<@UBOT> hi', ts: '5.5' } });
    await wait(100);
    const mention = slack.sent('chat.postMessage').at(-1).body;
    assert.strictEqual(mention.thread_ts, '5.5', 'answered in the thread');
    assert.match(mention.text, /only work in a direct message/);
  } finally {
    adapter.stop();
    await slack.close();
  }
});

test('approvals: Run it / Don\'t run / View code, and only the asker can press', async () => {
  const slack = await mockSlack();
  let decision;
  const { adapter, store } = await startBridge(slack, {
    runner: { runTurn: async (t) => { decision = await t.requestApproval({ code: 'return rows.filter(r => r.a < 2)', explanation: 'Counts rows' }); return { answer: decision ? 'ran' : 'not run' }; } },
  });
  try {
    store.addUser({ id: 'U42' });
    slack.push('events_api', dmEvent('count rows'));
    await wait(150);
    const ask = slack.sent('chat.postMessage').find((c) => c.body.blocks?.some((b) => b.type === 'actions'));
    assert.match(ask.body.blocks[0].text.text, /^\*Approve before this runs\*\nCounts rows\n_Runs on your computer/);
    assert.ok(!JSON.stringify(ask.body.blocks.slice(0, -1)).includes('rows.filter'), 'the code is not in the message');
    const buttons = ask.body.blocks.at(-1).elements;
    assert.deepStrictEqual(buttons.map((b) => b.text.text), ['Run it', "Don't run", 'View code']);
    assert.strictEqual(buttons[0].style, 'primary');

    const press = (value, user) => slack.push('interactive', {
      type: 'block_actions', user: { id: user }, channel: { id: 'D1' }, trigger_id: 'trig1',
      actions: [{ action_id: `tlx_${value}`, value }], message: { ts: '1001' },
    });
    press(buttons[2].value, 'U42');
    await wait(100);
    const modal = slack.sent('views.open')[0].body;
    assert.strictEqual(modal.trigger_id, 'trig1');
    assert.match(modal.view.blocks[0].text.text, /^```return rows\.filter\(r =&gt; r\.a &lt; 2\)```$/);

    press(buttons[0].value, 'U99');
    await wait(100);
    assert.match(slack.sent('chat.postEphemeral').at(-1).body.text, /Only the person who asked/);
    assert.strictEqual(decision, undefined);

    press(buttons[0].value, 'U42');
    await wait(150);
    assert.strictEqual(decision, true);
    const settled = slack.sent('chat.update').at(-1).body;
    assert.strictEqual(settled.blocks.at(-1).type, 'context');
    assert.match(settled.blocks.at(-1).elements[0].text, /Approved — running\./);
    assert.ok(!settled.blocks.some((b) => b.type === 'actions'), 'buttons removed');
    assert.strictEqual(slack.sent('chat.postMessage').at(-1).body.text, 'ran');
  } finally {
    adapter.stop();
    await slack.close();
  }
});

test('a file sent in a DM is downloaded with the bot token and added as a connection; cancel works', async () => {
  const slack = await mockSlack();
  let imported;
  const { adapter, store } = await startBridge(slack, {
    importFile: async (p, opts) => { imported = { content: fs.readFileSync(p, 'utf8'), opts }; return { connection: { name: opts.name }, tables: [{ name: 'orders', columns: 2 }] }; },
  });
  try {
    store.addUser({ id: 'U42' });
    slack.push('events_api', dmEvent('Store orders', { subtype: 'file_share', files: [{ name: 'orders.csv', size: 20, url_private_download: slack.fileUrl('orders.csv') }] }));
    await wait(200);
    assert.strictEqual(imported.opts.name, 'Store orders');
    assert.match(imported.content, /^store,orders/);
    assert.strictEqual(slack.sent('chat.postMessage').at(-1).body.text, 'Added *Store orders* as a connection.\n• `orders` — 2 columns\nAsk me about it here, or use it in a workflow.');

    slack.push('events_api', dmEvent('cancel'));
    await wait(100);
    assert.match(slack.sent('chat.postMessage').at(-1).body.text, /^Nothing to cancel/);
    slack.push('events_api', dmEvent('edited', { subtype: 'message_changed' }));
    slack.push('events_api', dmEvent('from a bot', { bot_id: 'B2' }));
    await wait(100);
    assert.match(slack.sent('chat.postMessage').at(-1).body.text, /^Nothing to cancel/, 'edits and bot messages are ignored');
  } finally {
    adapter.stop();
    await slack.close();
  }
});

test('plans: Build it / Cancel buttons with step types and descriptions', async () => {
  const slack = await mockSlack();
  const { createWorkflowBuildRunner } = require('../../public/messaging/workflowBuild');
  const builds = createWorkflowBuildRunner({
    workflowBuilder: { executeBuild: async () => ({ workflowId: 'w1', workflowName: 'Headcount', nodes: [1, 2], edges: [1], warnings: [] }) },
    getDb: () => ({ findOneAsync: async () => null }), buildSkillHelpers: async () => ({}),
  });
  const { adapter, store, notes } = await startBridge(slack, {
    builds,
    runner: { runTurn: async () => ({ answer: 'Plan:', workflowPlan: { mode: 'new', name: 'Headcount', steps: [{ stepType: 'dataSource', label: 'Read employees', prompt: 'All rows.' }] } }) },
  });
  try {
    store.addUser({ id: 'U42' });
    slack.push('events_api', dmEvent('build a headcount workflow'));
    await wait(150);
    const offer = slack.sent('chat.postMessage').find((c) => c.body.blocks?.some((b) => b.type === 'actions'));
    assert.strictEqual(offer.body.blocks[0].text.text, '*Headcount* · 1 step\n\n🟦 *1. Read employees*  `DATA SOURCE`\nAll rows.');
    const build = offer.body.blocks.at(-1).elements[0];
    assert.strictEqual(build.text.text, 'Build it');
    slack.push('interactive', { type: 'block_actions', user: { id: 'U42' }, channel: { id: 'D1' }, actions: [{ value: build.value }] });
    await wait(200);
    assert.match(slack.sent('chat.postMessage').at(-1).body.text, /^✓ Built "Headcount" — 2 nodes, 1 edge\./);
    assert.match(notes.at(-1)[3].planStatus.message, /\(built from Slack\)$/);
  } finally {
    adapter.stop();
    await slack.close();
  }
});

test('bad tokens are reported, not stored', async () => {
  const slack = await mockSlack();
  try {
    const api = createSlackApi({ botToken: BOT, appToken: 'xapp-wrong', baseUrl: slack.apiBase });
    await assert.rejects(api.openConnection(), /apps\.connections\.open failed: invalid_auth/);
    const noTok = createSlackApi({ botToken: null, baseUrl: slack.apiBase });
    await assert.rejects(noTok.authTest(), /no_token/);
  } finally {
    await slack.close();
  }
});
