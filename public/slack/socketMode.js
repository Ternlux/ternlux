/**
 * Slack Socket Mode client: one WebSocket Slack pushes events and button
 * presses down, so the app needs no public URL — it works while Ternlux is open.
 * https://docs.slack.dev/apis/events-api/using-socket-mode/
 *
 *   - every envelope is acknowledged at once (Slack retries after 3 seconds)
 *   - a retried event that was already handled is dropped (event_id)
 *   - Slack closes connections routinely ("disconnect" envelopes, refreshes);
 *     a fresh URL is fetched and the socket reopened, with backoff on failure
 *
 * Uses the WebSocket built into Node 22 / Electron's main process, so there is
 * no extra dependency. Emits 'event' (an Events API payload), 'interactive'
 * (a block_actions payload), 'connected' and 'error'.
 */

const { EventEmitter } = require('events');

const SEEN_EVENTS_MAX = 500;

class SocketModeClient extends EventEmitter {
  /**
   * @param {object} opts
   * @param {Function} opts.openUrl  () → Promise<string>, a fresh wss:// URL (apps.connections.open)
   * @param {Function} [opts.WebSocketImpl]
   */
  constructor({ openUrl, WebSocketImpl = globalThis.WebSocket, log = console }) {
    super();
    if (typeof WebSocketImpl !== 'function') throw new Error('No WebSocket implementation is available');
    this.openUrl = openUrl;
    this.WebSocketImpl = WebSocketImpl;
    this.log = log;
    this.running = false;
    this.ws = null;
    this.connected = false;
    this.seen = [];
    this.backoff = 1000;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.connect();
  }

  stop() {
    this.running = false;
    this.connected = false;
    try { this.ws?.close(); } catch (_err) { /* already closed */ }
    this.ws = null;
  }

  async connect() {
    if (!this.running) return;
    let url;
    try {
      url = await this.openUrl();
    } catch (err) {
      this.emit('error', err);
      return this.retry();
    }
    if (!this.running) return undefined;
    const ws = new this.WebSocketImpl(url);
    this.ws = ws;
    ws.addEventListener('message', (e) => this.onMessage(ws, e.data));
    ws.addEventListener('close', () => {
      if (this.ws !== ws) return; // replaced by a refresh
      this.connected = false;
      if (this.running) this.retry();
    });
    ws.addEventListener('error', () => { /* 'close' follows and reconnects */ });
    return undefined;
  }

  retry() {
    const wait = this.backoff;
    this.backoff = Math.min(this.backoff * 2, 30_000);
    setTimeout(() => this.connect(), wait).unref?.();
  }

  onMessage(ws, raw) {
    let msg;
    try { msg = JSON.parse(String(raw)); } catch (_err) { return; }
    if (msg.type === 'hello') {
      this.connected = true;
      this.backoff = 1000;
      this.emit('connected');
      return;
    }
    if (msg.type === 'disconnect') {
      // Slack is about to close this socket: open the next one first.
      this.ws = null;
      this.connected = false;
      this.connect();
      setTimeout(() => { try { ws.close(); } catch (_err) { /* gone */ } }, 1000).unref?.();
      return;
    }
    if (msg.envelope_id) {
      try { ws.send(JSON.stringify({ envelope_id: msg.envelope_id })); } catch (_err) { /* socket closing */ }
    }
    if (msg.type === 'events_api') {
      const id = msg.payload?.event_id;
      if (id) {
        if (this.seen.includes(id)) return;
        this.seen.push(id);
        if (this.seen.length > SEEN_EVENTS_MAX) this.seen.shift();
      }
      this.emit('event', msg.payload);
    } else if (msg.type === 'interactive') {
      this.emit('interactive', msg.payload);
    }
  }
}

module.exports = { SocketModeClient };
