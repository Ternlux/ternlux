/**
 * Slack adapter for the messaging bridge (public/messaging/bridge.js).
 *
 * Receives over Socket Mode (public/slack/socketMode.js) and replies through
 * the Web API (public/slack/webApi.js):
 *   - a direct message to the bot   → a 'message' event (isPrivate)
 *   - an @mention in a channel      → a 'message' event (not private — the
 *                                     bridge answers in that thread that it
 *                                     only works in direct messages)
 *   - a button press                → an 'action' event
 *
 * Commands are plain words — `new`, `cancel`, `help`, `pair 123456` — sent as
 * the whole message: Slack's client treats a leading "/" as one of its own
 * slash commands and never delivers it.
 *
 * Generated code is not pasted into the conversation: the approval message
 * carries a View code button that opens it in a pop-up, so the message reads
 * as the description.
 */

const { markdownToMrkdwn, renderLines, sections, escapeMrkdwn, splitForSections } = require('./format');

const MAX_FILE_BYTES = 100 * 1024 * 1024;
const WORKING_REACTION = 'hourglass_flowing_sand';
const COMMANDS = new Set(['new', 'cancel', 'help', 'pair', 'start']);

class SlackAdapter {
  /**
   * @param {object} deps
   * @param {object} deps.api     createSlackApi(…)
   * @param {object} deps.socket  a SocketModeClient (or anything emitting 'event' / 'interactive')
   */
  constructor({ api, socket, log = console }) {
    this.api = api;
    this.socket = socket;
    this.log = log;
    this.platform = 'slack';
    this.label = 'Slack';
    this.groupWord = 'channels';
    this.fileNameHint = 'Type a name in the same message to name it.';
    this.maxFileBytes = MAX_FILE_BYTES;
    this.botUserId = null;
    this.userNames = new Map();
    this.codeByToken = new Map(); // approval token → code, for View code
  }

  get running() { return Boolean(this.socket?.running); }

  // ── receiving ───────────────────────────────────────────────────────────

  start(onEvent, { botUserId = null } = {}) {
    this.onEvent = onEvent;
    this.botUserId = botUserId;
    this.socket.on('event', (payload) => this.dispatch(this.fromEvent(payload)));
    this.socket.on('interactive', (payload) => this.onInteractive(payload));
    this.socket.on('error', (err) => this.log.warn('[slack] connection error:', err.message));
    this.socket.start();
  }

  stop() { this.socket.stop(); }

  dispatch(eventPromise) {
    Promise.resolve(eventPromise)
      .then((event) => (event ? this.onEvent(event) : null))
      .catch((err) => this.log.error('[slack] event failed:', err.message));
  }

  async nameOf(userId) {
    if (this.userNames.has(userId)) return this.userNames.get(userId);
    let info = { name: '', username: null };
    try {
      const { user } = await this.api.usersInfo(userId);
      info = { name: user?.profile?.real_name || user?.real_name || user?.name || '', username: user?.name || null };
    } catch (_err) { /* users:read missing — the id still works */ }
    this.userNames.set(userId, info);
    return info;
  }

  // An Events API payload → a bridge event (or null to ignore it).
  async fromEvent(payload) {
    const ev = payload?.event;
    if (!ev || ev.bot_id || (this.botUserId && ev.user === this.botUserId)) return null;
    // A DM. Edits, deletions and joins arrive as subtypes; a file is 'file_share'.
    const isDm = ev.type === 'message' && ev.channel_type === 'im';
    const isMention = ev.type === 'app_mention';
    if (!isDm && !isMention) return null;
    if (ev.subtype && ev.subtype !== 'file_share') return null;
    const f = Array.isArray(ev.files) && ev.files[0];
    const names = await this.nameOf(ev.user);
    return {
      kind: 'message',
      chatId: ev.channel,
      user: { id: ev.user, ...names },
      isPrivate: isDm,
      text: this.stripMention(ev.text || ''),
      file: f ? { ref: f.url_private_download || f.url_private, name: f.name, size: f.size } : null,
      photo: false,
      messageTs: ev.ts,
      // A mention is answered in its thread rather than in the channel itself.
      replyTo: isMention ? (ev.thread_ts || ev.ts) : null,
    };
  }

  stripMention(text) {
    return String(text).replace(/<@[A-Z0-9]+>\s*/g, '').trim();
  }

  async onInteractive(payload) {
    if (payload?.type !== 'block_actions') return;
    const act = payload.actions?.[0];
    if (!act) return;
    const data = act.value || '';
    const chatId = payload.channel?.id || payload.container?.channel_id;
    const userId = payload.user?.id;
    // View code: opened here, nothing for the bridge to decide.
    if (data.startsWith('cv:')) {
      const code = this.codeByToken.get(data.slice(3));
      await this.openCode(payload.trigger_id, code).catch((err) => this.log.warn('[slack] could not open the code:', err.message));
      return;
    }
    this.dispatch({
      kind: 'action',
      chatId,
      userId,
      data,
      // Slack has no toast for a button press. The outcome shows as the message
      // being updated; a refusal (someone else pressed, or it expired) is said
      // privately to the person who pressed.
      ack: async (text, { refusal = false } = {}) => {
        if (refusal && chatId && userId) {
          await this.api.postEphemeral({ channel: chatId, user: userId, text }).catch(() => {});
        }
      },
    });
  }

  // `cancel`, `new`, `help`, `pair 123456` as the whole message → { name, arg }.
  parseCommand(text) {
    const m = String(text || '').trim().match(/^\/?([a-z]+)(?:\s+(\S+))?\s*$/i);
    if (!m || !COMMANDS.has(m[1].toLowerCase())) return null;
    return { name: m[1].toLowerCase(), arg: (m[2] || '').trim() };
  }

  commandHint(name) { return `“${name}”`; }

  // ── sending ─────────────────────────────────────────────────────────────

  async post(chatId, text, extra = {}) {
    const res = await this.api.postMessage({ channel: chatId, text, unfurl_links: false, unfurl_media: false, ...extra });
    return { chatId, ts: res.ts };
  }

  async postMrkdwn(chatId, mrkdwn, { replyTo = null } = {}) {
    // Long text goes as section blocks (3,000 characters each); `text` is the
    // notification fallback.
    const blocks = mrkdwn.length > 2900 ? sections(mrkdwn).slice(0, 50) : undefined;
    return this.post(chatId, mrkdwn.slice(0, 3000), { ...(blocks ? { blocks } : {}), ...(replyTo ? { thread_ts: replyTo } : {}) });
  }

  sendPlain(chatId, text, opts = {}) { return this.postMrkdwn(chatId, escapeMrkdwn(text), opts); }
  sendRich(chatId, lines) { return this.postMrkdwn(chatId, renderLines(lines)); }
  sendMarkdown(chatId, md) { return this.postMrkdwn(chatId, markdownToMrkdwn(md)); }
  sendPreformatted(chatId, text) { return this.postMrkdwn(chatId, `\`\`\`${escapeMrkdwn(text)}\`\`\``); }
  sendPhoto(chatId, png, name, caption) {
    return this.api.uploadFile({ channel: chatId, buffer: png, filename: name, title: caption || name, initialComment: caption });
  }
  sendFile(chatId, buffer, name, caption) {
    return this.api.uploadFile({ channel: chatId, buffer, filename: name, title: caption || name, initialComment: caption });
  }

  buttonBlock(buttons) {
    return {
      type: 'actions',
      elements: buttons.map((b) => ({
        type: 'button',
        action_id: `tlx_${b.data}`,
        value: b.data,
        text: { type: 'plain_text', text: b.label },
        ...(b.style ? { style: b.style } : {}),
      })),
    };
  }

  async sendBlocks(chatId, mrkdwn, buttons) {
    const blocks = [...sections(mrkdwn).slice(0, 48), this.buttonBlock(buttons)];
    const sent = await this.post(chatId, mrkdwn.slice(0, 3000), { blocks });
    return { ...sent, mrkdwn };
  }

  sendButtons(chatId, lines, buttons) { return this.sendBlocks(chatId, renderLines(lines), buttons); }

  sendApproval(chatId, { token, title, explanation, code, buttons }) {
    const mrkdwn = [
      `*${escapeMrkdwn(title)}*`,
      explanation ? escapeMrkdwn(explanation) : '',
      '_Runs on your computer with your saved connections._',
    ].filter(Boolean).join('\n');
    if (code) this.codeByToken.set(token, code);
    const all = code ? [...buttons, { label: 'View code', data: `cv:${token}` }] : buttons;
    return this.sendBlocks(chatId, mrkdwn, all).then((h) => ({ ...h, token }));
  }

  // Replace a buttoned message's buttons with a status line.
  async settle(handle, note) {
    if (!handle?.ts) return;
    if (handle.token) {
      // Keep View code working a little longer, then let it go.
      setTimeout(() => this.codeByToken.delete(handle.token), 10 * 60 * 1000).unref?.();
    }
    const blocks = [
      ...sections(handle.mrkdwn).slice(0, 48),
      { type: 'context', elements: [{ type: 'mrkdwn', text: `_${escapeMrkdwn(note)}_` }] },
    ];
    await this.api.update({ channel: handle.chatId, ts: handle.ts, text: handle.mrkdwn.slice(0, 3000), blocks });
  }

  async openCode(triggerId, code) {
    if (!triggerId) return;
    const body = code ? escapeMrkdwn(code) : '(this code is no longer available)';
    const blocks = splitForSections(body, 2900 - 6).slice(0, 100)
      .map((chunk) => ({ type: 'section', text: { type: 'mrkdwn', text: `\`\`\`${chunk}\`\`\`` } }));
    await this.api.viewsOpen({
      trigger_id: triggerId,
      view: {
        type: 'modal',
        title: { type: 'plain_text', text: 'Code to run' },
        close: { type: 'plain_text', text: 'Close' },
        blocks,
      },
    });
  }

  // Slack shows no typing indicator for bots: an hourglass reaction on the
  // user's message stands in, removed when the answer is done.
  startWorking(chatId, event) {
    const ts = event?.messageTs;
    if (!ts) return () => {};
    this.api.reactionsAdd({ channel: chatId, timestamp: ts, name: WORKING_REACTION }).catch(() => {});
    return () => { this.api.reactionsRemove({ channel: chatId, timestamp: ts, name: WORKING_REACTION }).catch(() => {}); };
  }

  downloadFile(file) { return this.api.downloadFile(file.ref); }
}

module.exports = { SlackAdapter, MAX_FILE_BYTES, WORKING_REACTION };
