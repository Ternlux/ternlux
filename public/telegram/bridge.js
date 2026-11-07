/**
 * Telegram ↔ chat assistant bridge: the shared messaging bridge
 * (public/messaging/bridge.js) driven by the Telegram adapter
 * (public/telegram/adapter.js).
 *
 * Long-polls the Bot API, so it needs no server or public URL — it works while
 * Ternlux is open. Only paired users get answers: pairing is a one-time code
 * shown in Settings → Telegram, sent to the bot as `/pair 123456` (or opened
 * as the link t.me/<bot>?start=123456).
 */

const { MessagingBridge, planLines, FILE_TYPE_BY_EXT, APPROVAL_TTL_MS } = require('../messaging/bridge');
const { TelegramAdapter, renderLines, MAX_DOWNLOAD_BYTES } = require('./adapter');

class TelegramBridge {
  /**
   * @param {object} deps  as MessagingBridge, plus `api` (createBotApi(…)) in place of `adapter`
   */
  constructor({ api, store, log = console, ...rest }) {
    this.adapter = new TelegramAdapter({ api, store, log });
    this.core = new MessagingBridge({ ...rest, store, log, adapter: this.adapter });
  }

  get running() { return this.adapter.running; }

  start() { this.adapter.start((event) => this.core.handle(event)); }

  stop() {
    this.adapter.stop();
    this.core.stop();
  }

  // One Bot API update, as the poll loop delivers it.
  handleUpdate(update) {
    const event = this.adapter.normalize(update);
    return event ? this.core.handle(event) : Promise.resolve();
  }

  reply(chatId, text, opts) { return this.adapter.reply(chatId, text, opts); }
}

// A workflow plan as Telegram HTML.
const planToHtml = (plan) => renderLines(planLines(plan));

module.exports = { TelegramBridge, planToHtml, FILE_TYPE_BY_EXT, APPROVAL_TTL_MS, MAX_DOWNLOAD_BYTES };
