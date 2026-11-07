/**
 * The Slack bridge as a main-process service: this computer's Slack app (its
 * name and manifest), its two tokens, lifecycle, and the IPC the Settings
 * screen calls. Same bridge as Telegram (public/messaging/bridge.js), with the
 * Slack adapter (public/slack/adapter.js).
 *
 * `TERNLUX_SLACK_API` points the Web API at another host — tests use it to run
 * against a local mock.
 */

const { createSlackApi } = require('./webApi');
const { SocketModeClient } = require('./socketMode');
const { SlackAdapter } = require('./adapter');
const { buildManifest, createAppUrl, defaultBotName, cleanName } = require('./manifest');
const { createStore } = require('../telegram/store');
const { MessagingBridge } = require('../messaging/bridge');
const { createMessagingDeps } = require('../messaging/deps');
const { createFileImporter } = require('../messaging/fileImport');

const APP_TOKEN = /^xapp-[\w-]{20,}$/;
const BOT_TOKEN = /^xoxb-[\w-]{20,}$/;

function createSlackService({
  app, safeStorage, BrowserWindow, getDb, buildSkillHelpers, chatAssistant, registerLocalFile,
  broadcast = () => {}, log = console, WebSocketImpl = undefined,
}) {
  const userData = app.getPath('userData');
  const baseUrl = process.env.TERNLUX_SLACK_API || undefined;
  const store = createStore({
    dir: userData,
    fileName: 'slack.json',
    encrypt: (s) => safeStorage.encryptString(s).toString('base64'),
    decrypt: (b) => safeStorage.decryptString(Buffer.from(b, 'base64')),
  });
  const shared = createMessagingDeps({ chatAssistant, getDb, buildSkillHelpers, BrowserWindow, broadcast });
  const files = createFileImporter({
    userData, folder: 'slack-files', getDb, registerLocalFile, broadcast, description: 'Added from Slack',
  });
  let adapter = null;
  let core = null;

  const apiFor = (botToken, appToken) => createSlackApi({ botToken, appToken, baseUrl });

  function start() {
    stop();
    const s = store.get();
    if (!s.enabled || !s.secrets) return false;
    const api = apiFor(store.getSecret('botToken'), store.getSecret('appToken'));
    const socket = new SocketModeClient({
      openUrl: async () => (await api.openConnection()).url,
      ...(WebSocketImpl ? { WebSocketImpl } : {}),
      log,
    });
    adapter = new SlackAdapter({ api, socket, log });
    core = new MessagingBridge({ adapter, store, log, ...files, ...shared });
    adapter.start((event) => core.handle(event), { botUserId: s.bot?.userId || null });
    log.log(`[slack] bridge running as ${s.bot?.name || 'unknown'} in ${s.bot?.team || 'unknown workspace'}`);
    return true;
  }

  function stop() {
    if (adapter) adapter.stop();
    if (core) core.stop();
    adapter = null;
    core = null;
  }

  function status() {
    const s = store.get();
    const pairingActive = s.pairing && Date.now() < s.pairing.expiresAt;
    const name = s.appName || defaultBotName();
    return {
      configured: Boolean(s.secrets),
      enabled: Boolean(s.enabled),
      running: Boolean(adapter && adapter.running),
      connected: Boolean(adapter?.socket?.connected),
      appName: name,
      defaultName: defaultBotName(),
      bot: s.bot || null,
      users: (s.users || []).map(({ id, name: n, username, pairedAt }) => ({ id, name: n, username, pairedAt })),
      pairing: pairingActive ? { code: s.pairing.code, expiresAt: s.pairing.expiresAt } : null,
    };
  }

  // The manifest for the name the user chose, and the link that opens Slack's
  // create-app page with it filled in.
  function manifest(name) {
    const appName = cleanName(name);
    store.patch({ appName });
    const m = buildManifest(appName);
    return { appName, manifest: m, json: JSON.stringify(m, null, 2), createUrl: createAppUrl(m) };
  }

  async function setTokens({ appToken, botToken }) {
    const a = String(appToken || '').trim();
    const b = String(botToken || '').trim();
    if (!APP_TOKEN.test(a)) {
      return { success: false, message: 'The app-level token should start with xapp- (Basic Information → App-Level Tokens).' };
    }
    if (!BOT_TOKEN.test(b)) {
      return { success: false, message: 'The bot token should start with xoxb- (OAuth & Permissions → Bot User OAuth Token).' };
    }
    const api = apiFor(b, a);
    let who;
    try {
      who = await api.authTest();
    } catch (err) {
      return { success: false, message: err.code === 'invalid_auth' ? 'Slack rejected the bot token.' : err.message };
    }
    try {
      await api.openConnection();
    } catch (err) {
      return {
        success: false,
        message: err.code === 'invalid_auth' || err.code === 'not_allowed_token_type'
          ? 'Slack rejected the app-level token — create one with the connections:write scope.'
          : `${err.message}. Is Socket Mode switched on for the app?`,
      };
    }
    store.setSecrets({ appToken: a, botToken: b }, {
      team: who.team, teamId: who.team_id, name: who.user, userId: who.user_id, botId: who.bot_id, url: who.url,
    });
    store.setEnabled(true);
    start();
    return { success: true, status: status() };
  }

  function registerIpc(ipcMain) {
    ipcMain.handle('slack:status', () => status());
    ipcMain.handle('slack:manifest', (_e, { name } = {}) => manifest(name));
    ipcMain.handle('slack:set-tokens', (_e, tokens = {}) => setTokens(tokens));
    ipcMain.handle('slack:clear', () => { stop(); store.clearToken(); return status(); });
    ipcMain.handle('slack:set-enabled', (_e, { enabled } = {}) => {
      store.setEnabled(enabled);
      if (enabled) start(); else stop();
      return status();
    });
    ipcMain.handle('slack:new-pairing-code', () => { store.newPairingCode(); return status(); });
    ipcMain.handle('slack:remove-user', (_e, { userId } = {}) => { store.removeUser(userId); return status(); });
  }

  return { start, stop, status, setTokens, manifest, registerIpc, store };
}

module.exports = { createSlackService, APP_TOKEN, BOT_TOKEN };
