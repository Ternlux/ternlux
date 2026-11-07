/**
 * Minimal Slack Web API client — only the calls the bridge uses.
 * https://docs.slack.dev/reference/methods
 *
 * Two tokens: the bot token (xoxb-) for everything the bot does, and the
 * app-level token (xapp-) only to open a Socket Mode connection. Errors carry
 * Slack's own error code (`not_authed`, `channel_not_found`…), never a token.
 * `baseUrl` is overridable so tests can point it at a local mock.
 */

const axios = require('axios');

const DEFAULT_BASE_URL = 'https://slack.com/api';

class SlackApiError extends Error {
  constructor(method, code, status = null) {
    super(`Slack ${method} failed: ${code}`);
    this.method = method;
    this.code = code;
    this.status = status;
  }
}

function createSlackApi({ botToken, appToken = null, baseUrl = DEFAULT_BASE_URL, http = axios }) {
  const root = String(baseUrl).replace(/\/+$/, '');

  async function call(method, body = {}, { token = botToken, form = false, retried = false } = {}) {
    if (!token) throw new SlackApiError(method, 'no_token');
    let res;
    try {
      res = await http.post(`${root}/${method}`, form ? new URLSearchParams(body).toString() : body, {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': form ? 'application/x-www-form-urlencoded' : 'application/json; charset=utf-8',
        },
        timeout: 30_000,
        validateStatus: () => true,
      });
    } catch (err) {
      throw new SlackApiError(method, err.code || err.message);
    }
    // Rate limited: wait as long as Slack says, once.
    if (res.status === 429 && !retried) {
      const wait = Number(res.headers?.['retry-after'] || 1) * 1000;
      await new Promise((r) => setTimeout(r, Math.min(wait, 30_000)));
      return call(method, body, { token, form, retried: true });
    }
    const data = res.data || {};
    if (!data.ok) throw new SlackApiError(method, data.error || `http_${res.status}`, res.status);
    return data;
  }

  /**
   * Upload a file into a conversation: Slack's two-step external upload —
   * reserve an upload URL, send the bytes there, then share it.
   */
  async function uploadFile({ channel, buffer, filename, title, initialComment, threadTs }) {
    const reserved = await call('files.getUploadURLExternal', { filename, length: String(buffer.length) }, { form: true });
    const res = await http.post(reserved.upload_url, buffer, {
      headers: { 'Content-Type': 'application/octet-stream' },
      timeout: 120_000,
      validateStatus: () => true,
      maxBodyLength: Infinity,
    });
    if (res.status < 200 || res.status >= 300) throw new SlackApiError('upload', `http_${res.status}`, res.status);
    return call('files.completeUploadExternal', {
      files: [{ id: reserved.file_id, title: title || filename }],
      channel_id: channel,
      ...(initialComment ? { initial_comment: initialComment } : {}),
      ...(threadTs ? { thread_ts: threadTs } : {}),
    });
  }

  // A file a user sent (its url_private_download) — private, so it needs the bot token.
  async function downloadFile(url) {
    const res = await http.get(url, {
      headers: { Authorization: `Bearer ${botToken}` },
      responseType: 'arraybuffer',
      timeout: 120_000,
      validateStatus: () => true,
    });
    if (res.status !== 200) throw new SlackApiError('downloadFile', `http_${res.status}`, res.status);
    // A missing files:read scope answers 200 with Slack's HTML sign-in page.
    const type = String(res.headers?.['content-type'] || '');
    if (type.startsWith('text/html')) throw new SlackApiError('downloadFile', 'not_a_file — check the files:read scope');
    return Buffer.from(res.data);
  }

  return {
    call,
    authTest: () => call('auth.test'),
    openConnection: () => call('apps.connections.open', {}, { token: appToken }),
    postMessage: (params) => call('chat.postMessage', params),
    postEphemeral: (params) => call('chat.postEphemeral', params),
    update: (params) => call('chat.update', params),
    viewsOpen: (params) => call('views.open', params),
    reactionsAdd: (params) => call('reactions.add', params),
    reactionsRemove: (params) => call('reactions.remove', params),
    usersInfo: (user) => call('users.info', { user }, { form: true }),
    uploadFile,
    downloadFile,
  };
}

module.exports = { createSlackApi, SlackApiError, DEFAULT_BASE_URL };
