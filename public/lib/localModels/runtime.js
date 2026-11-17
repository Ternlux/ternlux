/**
 * Local model runtime: llama.cpp's `llama-server`, started only when needed.
 *
 * Ternlux talks to every AI provider through an OpenAI-compatible API. For
 * local models that API is this module's PROXY — a small HTTP server on
 * 127.0.0.1 that is always listening (it costs nothing idle) and starts the
 * real model servers on demand:
 *
 *   POST /v1/chat/completions, /v1/completions → the "chat" llama-server
 *   POST /v1/embeddings                        → the "embedding" llama-server
 *   GET  /v1/models                            → installed models, each typed
 *                                                 "chat" or "embedding"
 *
 * Each role is one llama-server process holding one model. A request naming a
 * different model of that role swaps it (once in-flight requests finish). A
 * role's process is stopped after IDLE_MS without requests, and both are
 * stopped when the app quits. Nothing runs at all until a local model is used.
 */

const fs = require('fs');
const os = require('os');
const net = require('net');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const store = require('./store');

const IDLE_MS = 10 * 60 * 1000;
const START_TIMEOUT_MS = 3 * 60 * 1000;
const CHAT_CONTEXT = 16384;
const EMBED_CONTEXT = 8192;

let binary = null;        // { path, dir } once resolved
let proxy = null;         // http.Server
let proxyPort = null;
const roles = {
  chat: { proc: null, model: null, port: null, starting: null, inflight: 0, idleTimer: null, lastError: null, busySince: null },
  embedding: { proc: null, model: null, port: null, starting: null, inflight: 0, idleTimer: null, lastError: null, busySince: null },
};

/**
 * Where llama-server lives: <resources>/llama-server in a packaged app,
 * resources/llama-server/<platform>-<arch> in development.
 */
function resolveBinary({ resourcesPath, appRoot, isPackaged }) {
  const candidates = isPackaged
    ? [path.join(resourcesPath, 'llama-server')]
    : [path.join(appRoot, 'resources', 'llama-server', `${process.platform}-${process.arch}`)];
  for (const dir of candidates) {
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(dir, 'server.json'), 'utf8'));
      const exe = path.join(dir, meta.server);
      if (fs.existsSync(exe)) return { path: exe, dir: path.dirname(exe), build: meta.build };
    } catch (_) { /* not here */ }
  }
  return null;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function waitHealthy(state, port) {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!state.proc || state.proc.exitCode != null) {
      throw new Error(`The local model server stopped while loading.${state.lastError ? ` ${state.lastError}` : ''}`);
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return;
    } catch (_) { /* still starting */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('The local model took too long to load.');
}

function argsFor(role, modelPath, port) {
  const common = ['-m', modelPath, '--host', '127.0.0.1', '--port', String(port), '-ngl', '999', '-np', '1', '--no-webui'];
  if (role === 'embedding') {
    // Each input must fit in one micro-batch for embedding models.
    return [...common, '--embeddings', '-c', String(EMBED_CONTEXT), '-b', String(EMBED_CONTEXT), '-ub', String(EMBED_CONTEXT)];
  }
  return [...common, '--jinja', '-c', String(CHAT_CONTEXT)];
}

async function stopRole(role) {
  const state = roles[role];
  clearTimeout(state.idleTimer);
  const proc = state.proc;
  state.proc = null;
  state.model = null;
  state.port = null;
  if (proc && proc.exitCode == null) {
    await new Promise((resolve) => {
      const t = setTimeout(() => { try { proc.kill('SIGKILL'); } catch (_) {} resolve(); }, 5000);
      proc.once('exit', () => { clearTimeout(t); resolve(); });
      try { proc.kill(); } catch (_) { resolve(); }
    });
  }
}

async function waitIdle(state) {
  while (state.inflight > 0) await new Promise((r) => setTimeout(r, 100));
}

/** Make sure `role` is serving `model`; returns its port. */
async function ensure(role, model) {
  const state = roles[role];
  if (state.proc && state.model === model.id && state.proc.exitCode == null && !state.starting) return state.port;
  if (state.starting) {
    await state.starting.catch(() => {});
    return ensure(role, model);
  }
  state.starting = (async () => {
    if (!binary) throw new Error('Local models are not available in this build (llama-server is missing).');
    await waitIdle(state);
    await stopRole(role);
    const port = await freePort();
    const env = { ...process.env };
    if (process.platform === 'linux') env.LD_LIBRARY_PATH = [binary.dir, env.LD_LIBRARY_PATH].filter(Boolean).join(':');
    console.log(`[local-models] starting ${role} server: ${model.id} on port ${port}`);
    const proc = spawn(binary.path, argsFor(role, store.pathOf(model), port), {
      cwd: binary.dir, env, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true,
    });
    state.proc = proc;
    state.model = model.id;
    state.port = port;
    state.lastError = null;
    let tail = '';
    proc.stderr.on('data', (d) => {
      tail = (tail + d.toString()).slice(-4000);
      const line = tail.trim().split('\n').reverse().find((l) => /error|failed|unable|out of memory/i.test(l));
      if (line) state.lastError = line.trim().slice(0, 300);
    });
    proc.on('error', (err) => { state.lastError = err.message; });
    proc.on('exit', (code) => {
      if (state.proc === proc) {
        console.log(`[local-models] ${role} server exited (${code})`);
        state.proc = null; state.model = null; state.port = null;
      }
    });
    await waitHealthy(state, port);
    return port;
  })();
  try {
    return await state.starting;
  } catch (err) {
    await stopRole(role);
    throw err;
  } finally {
    state.starting = null;
  }
}

function touch(role) {
  const state = roles[role];
  clearTimeout(state.idleTimer);
  state.idleTimer = setTimeout(() => {
    if (state.inflight === 0) {
      console.log(`[local-models] ${role} server idle — stopping`);
      stopRole(role);
    }
  }, IDLE_MS);
  if (state.idleTimer.unref) state.idleTimer.unref();
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

let defaultChatModel = () => null;

// Context size of the embedding server, per port (read from its /props).
const ctxByPort = new Map();

async function upstreamJson(port, p, body) {
  const res = await fetch(`http://127.0.0.1:${port}${p}`, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`${p} ${res.status}`);
  return res.json();
}

/**
 * Cut embedding inputs to what the model accepts. llama-server rejects an
 * input longer than the model's context ("input (1082 tokens) is larger than
 * the max context size (512 tokens)"), which would fail a whole batch of rows
 * over one long one. Like sentence-transformers, keep the first tokens instead.
 */
async function truncateInputs(port, input) {
  let ctx = ctxByPort.get(port);
  if (!ctx) {
    const props = await upstreamJson(port, '/props').catch(() => null);
    ctx = Number(props?.default_generation_settings?.n_ctx) || 0;
    if (ctx) ctxByPort.set(port, ctx);
  }
  if (!ctx) return input;
  const limit = Math.max(8, ctx - 8); // room for the model's own special tokens
  const one = async (text) => {
    if (typeof text !== 'string' || text.length < limit) return text; // a token is at least one character
    const { tokens } = await upstreamJson(port, '/tokenize', { content: text });
    if (!Array.isArray(tokens) || tokens.length <= limit) return text;
    const { content } = await upstreamJson(port, '/detokenize', { tokens: tokens.slice(0, limit) });
    return content;
  };
  return Array.isArray(input) ? Promise.all(input.map(one)) : one(input);
}

/** Which installed model serves a request for `name` in `role`. */
function modelFor(role, name) {
  const installed = store.list().filter((m) => m.role === role);
  return installed.find((m) => m.id === name)
    || (role === 'chat' ? installed.find((m) => m.id === defaultChatModel()) : null)
    || (installed.length === 1 ? installed[0] : null);
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://127.0.0.1');
  const p = url.pathname.replace(/\/+$/, '');

  if (req.method === 'GET' && (p === '/v1/models' || p === '/models')) {
    return sendJson(res, 200, {
      object: 'list',
      data: store.list().map((m) => ({ id: m.id, object: 'model', owned_by: 'local', type: m.role })),
    });
  }
  if (req.method === 'GET' && p === '/health') return sendJson(res, 200, { status: 'ok' });

  const role = /\/embeddings$/.test(p) ? 'embedding'
    : /\/(chat\/)?completions$/.test(p) ? 'chat' : null;
  if (!role || req.method !== 'POST') {
    return sendJson(res, 404, { error: { message: `Not supported by the local model server: ${req.method} ${p}` } });
  }

  const raw = await readBody(req);
  let body = {};
  try { body = JSON.parse(raw.toString('utf8') || '{}'); } catch (_) { /* forward as-is */ }
  const model = modelFor(role, body.model);
  if (!model) {
    return sendJson(res, 404, { error: { message: `Local ${role} model "${body.model || ''}" is not installed. Download one in Settings → AI Provider → Local Models.` } });
  }

  const state = roles[role];
  let port;
  try {
    port = await ensure(role, model);
  } catch (err) {
    return sendJson(res, 503, { error: { message: err.message } });
  }

  let payload = raw;
  if (role === 'embedding' && body.input != null) {
    try {
      payload = Buffer.from(JSON.stringify({ ...body, input: await truncateInputs(port, body.input) }));
    } catch (err) {
      console.warn('[local-models] could not check embedding input length:', err.message);
    }
  }

  if (state.inflight === 0) state.busySince = Date.now();
  state.inflight += 1;
  clearTimeout(state.idleTimer);
  const done = () => {
    state.inflight = Math.max(0, state.inflight - 1);
    if (state.inflight === 0) state.busySince = null;
    touch(role);
  };
  const upstream = http.request({
    host: '127.0.0.1', port, method: 'POST', path: `/v1${p.replace(/^\/v1/, '')}`,
    headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length },
  }, (up) => {
    res.writeHead(up.statusCode || 502, up.headers);
    up.pipe(res);
    up.on('end', done);
    up.on('error', done);
  });
  upstream.on('error', (err) => {
    done();
    if (!res.headersSent) sendJson(res, 502, { error: { message: `Local model server error: ${err.message}` } });
    else res.end();
  });
  req.on('aborted', () => upstream.destroy());
  upstream.end(payload);
}

/**
 * Start the proxy (cheap; no model is loaded). Resolves with its base URL, or
 * null when this build has no llama-server.
 * @param {Object} opts { resourcesPath, appRoot, isPackaged, getDefaultChatModel }
 */
async function start(opts) {
  binary = resolveBinary(opts);
  if (opts.getDefaultChatModel) defaultChatModel = opts.getDefaultChatModel;
  if (!binary) {
    console.warn('[local-models] llama-server not found — local models disabled');
    return null;
  }
  proxyPort = await freePort();
  proxy = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (!res.headersSent) sendJson(res, 500, { error: { message: err.message } });
    });
  });
  await new Promise((resolve) => proxy.listen(proxyPort, '127.0.0.1', resolve));
  console.log(`[local-models] llama-server ${binary.build} ready; proxy on 127.0.0.1:${proxyPort}`);
  return baseURL();
}

function baseURL() {
  return proxyPort ? `http://127.0.0.1:${proxyPort}/v1` : null;
}

async function shutdown() {
  await Promise.all(Object.keys(roles).map(stopRole));
  if (proxy) proxy.close();
}

/** Stop the server holding `modelId` (before its file is deleted). */
async function release(modelId) {
  await Promise.all(Object.keys(roles).filter((r) => roles[r].model === modelId).map(async (r) => {
    await waitIdle(roles[r]);
    await stopRole(r);
  }));
}

function status() {
  return {
    available: !!binary,
    build: binary?.build || null,
    baseURL: baseURL(),
    totalMemory: os.totalmem(),
    running: Object.fromEntries(Object.entries(roles).map(([r, s]) => [r, s.proc ? s.model : null])),
  };
}

/**
 * What the chat model server is doing right now, so a slow or failed request
 * can be explained to the user. Asks llama-server's /slots for the request in
 * progress: its size and how much of the answer is written. Never throws; a
 * field it couldn't learn is null.
 */
async function chatActivity() {
  const state = roles.chat;
  const activity = {
    running: !!(state.proc && state.port && state.proc.exitCode == null),
    model: state.model,
    requests: state.inflight,
    busySeconds: state.busySince ? Math.round((Date.now() - state.busySince) / 1000) : null,
    cpuCores: os.cpus().length,
    lastError: state.lastError,
    busy: null,
    promptTokens: null,
    writtenTokens: null,
  };
  if (!activity.running) return activity;
  try {
    const res = await fetch(`http://127.0.0.1:${state.port}/slots`, { signal: AbortSignal.timeout(3000) });
    const slots = res.ok ? await res.json() : null;
    if (Array.isArray(slots)) {
      const slot = slots.find((s) => s && s.is_processing) || null;
      activity.busy = !!slot;
      if (slot) {
        const next = Array.isArray(slot.next_token) ? slot.next_token[0] : slot.next_token;
        activity.promptTokens = Number(slot.n_prompt_tokens) || null;
        activity.writtenTokens = Number(next && next.n_decoded) || 0;
      }
    }
  } catch (_) { /* a server this busy may not answer in time */ }
  return activity;
}

module.exports = { start, shutdown, release, status, baseURL, chatActivity };
