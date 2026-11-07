/**
 * The assistant knows when a conversation is happening in Telegram or Slack:
 * the bridges tell it the platform, the main prompt then points it at that
 * app's own doc instead of the in-app chat panel's.
 *
 *   node --test testing/unit/chatApps.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { buildPrompt, chatAppSection } = require('../../public/chat/prompts');
const { createConversationRunner } = require('../../public/messaging/conversation');

const DOCS = path.join(__dirname, '../../public/docs');
const base = { docIndex: [], readme: '(readme)', snapshot: '{}', systemContext: '', maxActions: 4 };

test('Telegram and Slack each have their own doc, linked from the docs map', () => {
  for (const f of ['chat-apps/README.md', 'chat-apps/telegram.md', 'chat-apps/slack.md']) {
    assert.ok(fs.existsSync(path.join(DOCS, f)), `${f} exists`);
  }
  assert.match(fs.readFileSync(path.join(DOCS, 'README.md'), 'utf8'), /\(chat-apps\/README\.md\)/);
  assert.match(fs.readFileSync(path.join(DOCS, 'chat-apps/telegram.md'), 'utf8'), /\| `\/new` \|/);
  const slack = fs.readFileSync(path.join(DOCS, 'chat-apps/slack.md'), 'utf8');
  assert.match(slack, /\| `new` \|/);
  assert.match(slack, /without a\s+slash/);
});

test('the main prompt says which chat app the user is in and which doc answers "how do I…"', () => {
  const tg = buildPrompt('main', { ...base, channel: { platform: 'telegram' } }).text;
  assert.match(tg, /# Where this conversation is happening: Telegram/);
  assert.match(tg, /read_doc chat-apps\/telegram\.md/);
  assert.match(tg, /Do NOT answer\s+from chat-assistant\/README\.md/);
  assert.match(tg, /\/new \(new conversation\)/);

  const sl = buildPrompt('main', { ...base, channel: { platform: 'slack' } }).text;
  assert.match(sl, /# Where this conversation is happening: Slack/);
  assert.match(sl, /read_doc chat-apps\/slack\.md/);
  assert.match(sl, /"new", "cancel" and "help", sent as the whole message with NO slash/);

  // The in-app panel is unchanged.
  assert.doesNotMatch(buildPrompt('main', base).text, /Where this conversation is happening/);
  assert.strictEqual(chatAppSection({ platform: 'discord' }), '');
});

test('the background runner passes the chat app to the assistant', async () => {
  const seen = [];
  const docs = [];
  const db = {
    findOneAsync: async () => docs[0] || null,
    updateAsync: async (_q, { $set }) => { docs[0] = structuredClone($set); },
  };
  const runner = createConversationRunner({
    chatAssistant: { runStep: async (a) => { seen.push(a.channel); return { success: true, done: true, finalAnswer: 'ok' }; } },
    getDb: () => db,
    buildSkillHelpers: async () => ({}),
  });
  await runner.runTurn({ convoId: 'c1', text: 'how do I start a new chat', source: { platform: 'slack', chatId: 'D1' }, requestApproval: async () => false });
  await runner.runTurn({ convoId: 'c2', text: 'hi', requestApproval: async () => false });
  assert.deepStrictEqual(seen, [{ platform: 'slack' }, null]);
});
