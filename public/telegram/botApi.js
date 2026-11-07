/**
 * Minimal Telegram Bot API client — only the calls the bridge uses.
 * https://core.telegram.org/bots/api
 *
 * The token is part of every URL, so URLs are never logged and errors carry
 * only Telegram's own description. `baseUrl` is overridable so tests can point
 * the client at a local mock server.
 */

const axios = require('axios');

const DEFAULT_BASE_URL = 'https://api.telegram.org';

class TelegramApiError extends Error {
  constructor(method, status, description, retryAfter = null) {
    super(`Telegram ${method} failed${status ? ` (HTTP ${status})` : ''}: ${description || 'no description'}`);
    this.method = method;
    this.status = status;
    this.description = description;
    this.retryAfter = retryAfter;
  }
}

function createBotApi({ token, baseUrl = DEFAULT_BASE_URL, http = axios }) {
  if (!token) throw new Error('A bot token is required');
  const root = `${String(baseUrl).replace(/\/+$/, '')}/bot${token}`;

  const unwrap = (method, res) => {
    const body = res.data || {};
    if (res.status >= 200 && res.status < 300 && body.ok) return body.result;
    throw new TelegramApiError(method, res.status, body.description, body.parameters?.retry_after ?? null);
  };

  async function call(method, params = {}, { timeout = 30_000 } = {}) {
    let res;
    try {
      res = await http.post(`${root}/${method}`, params, { timeout, validateStatus: () => true });
    } catch (err) {
      // Network failure — say which call, never the URL (it holds the token).
      throw new TelegramApiError(method, null, err.code || err.message);
    }
    return unwrap(method, res);
  }

  // multipart/form-data upload of one file field (sendPhoto / sendDocument).
  async function upload(method, field, buffer, filename, params = {}) {
    const form = new FormData();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) form.append(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
    }
    form.append(field, new Blob([buffer]), filename);
    let res;
    try {
      res = await http.post(`${root}/${method}`, form, { timeout: 120_000, validateStatus: () => true });
    } catch (err) {
      throw new TelegramApiError(method, null, err.code || err.message);
    }
    return unwrap(method, res);
  }

  async function downloadFile(filePath) {
    const res = await http.get(`${String(baseUrl).replace(/\/+$/, '')}/file/bot${token}/${filePath}`, {
      responseType: 'arraybuffer', timeout: 120_000, validateStatus: () => true,
    });
    if (res.status !== 200) throw new TelegramApiError('downloadFile', res.status, 'download failed');
    return Buffer.from(res.data);
  }

  return {
    call,
    getMe: () => call('getMe'),
    getUpdates: (params, opts) => call('getUpdates', params, opts),
    sendMessage: (params) => call('sendMessage', params),
    editMessageText: (params) => call('editMessageText', params),
    answerCallbackQuery: (params) => call('answerCallbackQuery', params),
    sendChatAction: (chatId, action = 'typing') => call('sendChatAction', { chat_id: chatId, action }),
    getFile: (fileId) => call('getFile', { file_id: fileId }),
    sendPhoto: (chatId, buffer, filename, params = {}) => upload('sendPhoto', 'photo', buffer, filename, { chat_id: chatId, ...params }),
    sendDocument: (chatId, buffer, filename, params = {}) => upload('sendDocument', 'document', buffer, filename, { chat_id: chatId, ...params }),
    downloadFile,
  };
}

module.exports = { createBotApi, TelegramApiError, DEFAULT_BASE_URL };
