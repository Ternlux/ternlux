/**
 * The Telegram bridge as a main-process service: settings, lifecycle, the
 * file-to-connection import, and the IPC the Settings screen calls.
 *
 * Wired from electron.js once the app is ready (see `telegram.start()` there).
 * `TERNLUX_TELEGRAM_API` points the Bot API at another host — tests use it to
 * run the whole bridge against a local mock.
 */

const { createBotApi } = require('./botApi');
const { createStore } = require('./store');
const { TelegramBridge } = require('./bridge');
const { createMessagingDeps } = require('../messaging/deps');
const { createFileImporter } = require('../messaging/fileImport');

function createTelegramService({
  app, safeStorage, BrowserWindow, getDb, buildSkillHelpers, chatAssistant, registerLocalFile,
  broadcast = () => {}, log = console,
}) {
  const userData = app.getPath('userData');
  const baseUrl = process.env.TERNLUX_TELEGRAM_API || undefined;
  const store = createStore({
    dir: userData,
    encrypt: (s) => safeStorage.encryptString(s).toString('base64'),
    decrypt: (b) => safeStorage.decryptString(Buffer.from(b, 'base64')),
  });
  const shared = createMessagingDeps({ chatAssistant, getDb, buildSkillHelpers, BrowserWindow, broadcast });
  const { saveUpload, importFile } = createFileImporter({
    userData, folder: 'telegram-files', getDb, registerLocalFile, broadcast, description: 'Added from Telegram',
  });
  let bridge = null;

  function start() {
    stop();
    const s = store.get();
    if (!s.enabled || !s.token) return false;
    const api = createBotApi({ token: store.getToken(), baseUrl });
    bridge = new TelegramBridge({
      api, store, importFile, saveUpload, log, ...shared,
    });
    bridge.start();
    log.log(`[telegram] bridge running as @${s.bot?.username || 'unknown'}`);
    return true;
  }

  function stop() {
    if (bridge) bridge.stop();
    bridge = null;
  }

  function status() {
    const s = store.get();
    const pairingActive = s.pairing && Date.now() < s.pairing.expiresAt;
    return {
      configured: Boolean(s.token),
      enabled: Boolean(s.enabled),
      running: Boolean(bridge && bridge.running),
      bot: s.bot || null,
      users: (s.users || []).map(({ id, name, username, pairedAt }) => ({ id, name, username, pairedAt })),
      pairing: pairingActive
        ? { code: s.pairing.code, expiresAt: s.pairing.expiresAt, link: s.bot?.username ? `https://t.me/${s.bot.username}?start=${s.pairing.code}` : null }
        : null,
    };
  }

  async function setToken(token) {
    const clean = String(token || '').trim();
    if (!/^\d+:[\w-]{30,}$/.test(clean)) {
      return { success: false, message: 'That does not look like a bot token — it should look like 123456789:AA… (from @BotFather).' };
    }
    try {
      const me = await createBotApi({ token: clean, baseUrl }).getMe();
      store.setToken(clean, { id: me.id, username: me.username, name: me.first_name });
      store.setEnabled(true);
      start();
      return { success: true, status: status() };
    } catch (err) {
      return { success: false, message: err.status === 401 ? 'Telegram rejected that token.' : err.message };
    }
  }

  function registerIpc(ipcMain) {
    ipcMain.handle('telegram:status', () => status());
    ipcMain.handle('telegram:set-token', (_e, { token } = {}) => setToken(token));
    ipcMain.handle('telegram:clear-token', () => { stop(); store.clearToken(); return status(); });
    ipcMain.handle('telegram:set-enabled', (_e, { enabled } = {}) => {
      store.setEnabled(enabled);
      if (enabled) start(); else stop();
      return status();
    });
    ipcMain.handle('telegram:new-pairing-code', () => { store.newPairingCode(); return status(); });
    ipcMain.handle('telegram:remove-user', (_e, { userId } = {}) => { store.removeUser(userId); return status(); });
  }

  return { start, stop, status, setToken, registerIpc, importFile, store };
}

module.exports = { createTelegramService };
