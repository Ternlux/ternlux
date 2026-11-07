/**
 * Telegram adapter for the messaging bridge (public/messaging/bridge.js):
 * long-polls the Bot API for updates and renders the bridge's messages as
 * Telegram HTML. See public/telegram/bridge.js for how the two are joined.
 */

const { markdownToTelegramHtml, escapeHtml } = require('./format');

// Bot API limit for getFile downloads.
const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;

// Lines of styled spans (see bridge.js) → Telegram HTML.
function renderSpan(span) {
  if (typeof span === 'string') return escapeHtml(span);
  if (span.b !== undefined) return `<b>${escapeHtml(span.b)}</b>`;
  if (span.i !== undefined) return `<i>${escapeHtml(span.i)}</i>`;
  if (span.code !== undefined) return `<code>${escapeHtml(span.code)}</code>`;
  return '';
}
const renderLines = (lines) => lines.map((l) => (Array.isArray(l) ? l.map(renderSpan).join('') : renderSpan(l))).join('\n');
const stripHtml = (html) => html.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

class TelegramAdapter {
  constructor({ api, store, log = console }) {
    this.api = api;
    this.store = store;
    this.log = log;
    this.running = false;
    this.platform = 'telegram';
    this.label = 'Telegram';
    this.groupWord = 'group chats';
    this.fileNameHint = 'A caption names it.';
    this.maxFileBytes = MAX_DOWNLOAD_BYTES;
  }

  // ── receiving ───────────────────────────────────────────────────────────

  start(onEvent) {
    if (this.running) return;
    this.running = true;
    this.onEvent = onEvent;
    this.pollLoop();
  }

  // An in-flight long poll can take up to 25 seconds to return; quitting does
  // not wait for it — the loop exits when it does.
  stop() { this.running = false; }

  async pollLoop() {
    let backoff = 1000;
    while (this.running) {
      try {
        const updates = await this.api.getUpdates(
          { offset: this.store.get().offset || 0, timeout: 25, allowed_updates: ['message', 'callback_query'] },
          { timeout: 35_000 },
        );
        backoff = 1000;
        for (const u of updates || []) {
          this.store.setOffset(u.update_id + 1);
          const event = this.normalize(u);
          // Not awaited: one slow answer must not hold up a button press (an
          // approval) arriving in the same batch.
          if (event) Promise.resolve(this.onEvent(event)).catch((err) => this.log.error('[telegram] update failed:', err.message));
        }
      } catch (err) {
        if (!this.running) break;
        this.log.warn('[telegram] polling error:', err.message);
        await new Promise((r) => setTimeout(r, err.retryAfter ? err.retryAfter * 1000 : backoff));
        backoff = Math.min(backoff * 2, 30_000);
      }
    }
  }

  // A Bot API update → a bridge event (or null to ignore it).
  normalize(update) {
    const cb = update.callback_query;
    if (cb) {
      return {
        kind: 'action',
        chatId: cb.message?.chat?.id ?? null,
        userId: cb.from.id,
        data: cb.data,
        ack: (text) => this.api.answerCallbackQuery({ callback_query_id: cb.id, text }).catch(() => {}),
      };
    }
    const msg = update.message;
    if (!msg || !msg.from || msg.from.is_bot) return null;
    return {
      kind: 'message',
      chatId: msg.chat.id,
      user: {
        id: msg.from.id,
        name: [msg.from.first_name, msg.from.last_name].filter(Boolean).join(' '),
        username: msg.from.username || null,
      },
      isPrivate: msg.chat.type === 'private',
      text: msg.text || msg.caption || '',
      file: msg.document ? { ref: msg.document.file_id, name: msg.document.file_name, size: msg.document.file_size } : null,
      photo: Boolean(msg.photo),
    };
  }

  // `/cancel`, `/pair 123456`, `/new@MyBot` → { name, arg }.
  parseCommand(text) {
    const m = String(text || '').match(/^\/(\w+)(?:@\w+)?(?:\s+([\s\S]*))?$/);
    return m ? { name: m[1].toLowerCase(), arg: (m[2] || '').trim() } : null;
  }

  commandHint(name) { return `/${name}`; }

  // ── sending ─────────────────────────────────────────────────────────────

  /**
   * Send text. `markdown` converts the assistant's Markdown to Telegram HTML;
   * `html` sends prepared HTML. If Telegram rejects the markup, the plain text
   * goes out instead rather than the answer being lost.
   */
  async reply(chatId, text, { markdown = false, html = false, reply_markup } = {}) {
    if (!markdown && !html) {
      return this.api.sendMessage({ chat_id: chatId, text, disable_web_page_preview: true, ...(reply_markup ? { reply_markup } : {}) });
    }
    const body = markdown ? markdownToTelegramHtml(text) : text;
    try {
      return await this.api.sendMessage({
        chat_id: chatId, text: body, parse_mode: 'HTML', disable_web_page_preview: true, ...(reply_markup ? { reply_markup } : {}),
      });
    } catch (err) {
      if (err.status !== 400) throw err;
      return this.api.sendMessage({
        chat_id: chatId, text: markdown ? text : stripHtml(body), disable_web_page_preview: true, ...(reply_markup ? { reply_markup } : {}),
      });
    }
  }

  sendPlain(chatId, text) { return this.reply(chatId, text); }
  sendRich(chatId, lines) { return this.reply(chatId, renderLines(lines), { html: true }); }
  sendMarkdown(chatId, md) { return this.reply(chatId, md, { markdown: true }); }
  sendPreformatted(chatId, text) { return this.reply(chatId, `<pre>${escapeHtml(text)}</pre>`, { html: true }); }
  sendPhoto(chatId, png, name, caption) { return this.api.sendPhoto(chatId, png, name, caption ? { caption } : {}); }
  sendFile(chatId, buffer, name, caption) { return this.api.sendDocument(chatId, buffer, name, caption ? { caption } : {}); }

  // One row of inline buttons under prepared HTML. Returns a handle settle() edits.
  async sendHtmlWithButtons(chatId, html, buttons) {
    const reply_markup = { inline_keyboard: [buttons.map((b) => ({ text: b.label, callback_data: b.data }))] };
    const sent = await this.reply(chatId, html, { html: true, reply_markup });
    return { chatId, messageId: sent?.message_id, html };
  }

  sendButtons(chatId, lines, buttons) { return this.sendHtmlWithButtons(chatId, renderLines(lines), buttons); }

  // The description leads; the code sits in a collapsed quote the user taps to open.
  sendApproval(chatId, { title, explanation, code, buttons }) {
    const shown = code.length > 3000 ? `${code.slice(0, 3000)}\n… (${code.length - 3000} more characters)` : code;
    const html = [
      `<b>${escapeHtml(title)}</b>`,
      explanation ? escapeHtml(explanation) : '',
      shown ? `<i>Code — tap to expand</i>\n<blockquote expandable><code>${escapeHtml(shown)}</code></blockquote>` : '',
      'Runs on your computer with your saved connections.',
    ].filter(Boolean).join('\n');
    return this.sendHtmlWithButtons(chatId, html, buttons);
  }

  // Replace a buttoned message's buttons with a status line.
  async settle(handle, note) {
    if (!handle?.messageId) return;
    await this.api.editMessageText({
      chat_id: handle.chatId, message_id: handle.messageId, parse_mode: 'HTML',
      text: `${handle.html}\n\n<i>${escapeHtml(note)}</i>`,
    });
  }

  // "typing…" (or "sending a file…") until the returned function is called.
  startWorking(chatId, _event, kind = 'typing') {
    const action = kind === 'upload' ? 'upload_document' : 'typing';
    this.api.sendChatAction(chatId, action).catch(() => {});
    const timer = setInterval(() => { this.api.sendChatAction(chatId, action).catch(() => {}); }, 4500);
    return () => clearInterval(timer);
  }

  async downloadFile(file) {
    const info = await this.api.getFile(file.ref);
    return this.api.downloadFile(info.file_path);
  }
}

module.exports = { TelegramAdapter, renderLines, MAX_DOWNLOAD_BYTES };
