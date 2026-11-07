/**
 * Chat-bridge settings, kept in <userData>/<fileName> (telegram.json,
 * slack.json).
 *
 *   secrets     { name: encrypted } for bridges with more than one token (Slack)
 *
 *   enabled     whether the bridge should run
 *   token       the bot token, encrypted with the injected `encrypt` (safeStorage)
 *   bot         { id, username, name } from getMe, for display
 *   users       paired Telegram users allowed to talk to the bot
 *   pairing     { code, expiresAt } — a one-time code shown in Settings
 *   sessions    { [chatId]: convoId } — the chat's current conversation
 *   offset      the next getUpdates offset, so a restart does not replay messages
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PAIRING_TTL_MS = 10 * 60 * 1000;

function createStore({ dir, encrypt, decrypt, fileName = 'telegram.json' }) {
  const file = path.join(dir, fileName);

  const read = () => {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (_err) {
      return {};
    }
  };
  const write = (data) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 });
  };
  const update = (fn) => {
    const data = read();
    const next = fn(data) || data;
    write(next);
    return next;
  };

  return {
    file,
    get: () => read(),
    hasToken: () => Boolean(read().token),
    getToken: () => {
      const enc = read().token;
      return enc ? decrypt(enc) : null;
    },
    setToken: (token, bot) => update((d) => ({
      ...d, token: encrypt(token), bot, users: d.users || [], sessions: d.sessions || {}, offset: 0,
    })),
    clearToken: () => update((d) => ({ ...d, token: null, secrets: null, bot: null, enabled: false, offset: 0 })),
    // Several named secrets (Slack's app and bot tokens), each encrypted.
    setSecrets: (secrets, bot) => update((d) => ({
      ...d,
      secrets: Object.fromEntries(Object.entries(secrets).map(([k, v]) => [k, encrypt(v)])),
      bot,
      users: d.users || [],
      sessions: d.sessions || {},
    })),
    hasSecrets: () => Boolean(read().secrets),
    getSecret: (name) => {
      const enc = (read().secrets || {})[name];
      return enc ? decrypt(enc) : null;
    },
    setEnabled: (enabled) => update((d) => ({ ...d, enabled: !!enabled })),
    // Plain (non-secret) fields, e.g. Slack's chosen app name.
    patch: (fields) => update((d) => ({ ...d, ...fields })),
    setOffset: (offset) => update((d) => ({ ...d, offset })),

    users: () => read().users || [],
    isAllowed: (userId) => (read().users || []).some((u) => String(u.id) === String(userId)),
    addUser: (user) => update((d) => ({
      ...d,
      users: [...(d.users || []).filter((u) => String(u.id) !== String(user.id)), user],
      pairing: null,
    })),
    removeUser: (userId) => update((d) => ({
      ...d, users: (d.users || []).filter((u) => String(u.id) !== String(userId)),
    })),

    // A fresh 6-digit code, valid for 10 minutes and for one pairing.
    newPairingCode: (now = Date.now()) => {
      const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
      update((d) => ({ ...d, pairing: { code, expiresAt: now + PAIRING_TTL_MS } }));
      return { code, expiresAt: now + PAIRING_TTL_MS };
    },
    checkPairingCode: (code, now = Date.now()) => {
      const p = read().pairing;
      return Boolean(p && p.code && String(code).trim() === p.code && now < p.expiresAt);
    },

    sessionFor: (chatId) => (read().sessions || {})[String(chatId)] || null,
    setSession: (chatId, convoId) => update((d) => ({
      ...d, sessions: { ...(d.sessions || {}), [String(chatId)]: convoId },
    })),
  };
}

module.exports = { createStore, PAIRING_TTL_MS };
