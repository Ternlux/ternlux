/**
 * Embedding generation library for vector database operations.
 *
 * Every embedding is made with ONE model: the user's "Default Embedding Model"
 * from Settings → AI Provider (saved in ai-prefs.json). Nodes record the model
 * they were built with so stored vectors stay comparable; nothing here — and
 * no AI prompt — picks a provider or model on its own.
 *
 * Nothing about providers is hardcoded beyond what cannot be discovered:
 *   - which providers exist, their labels, base URLs and whether they need a
 *     key all come from aiProviders.js (the same config chat uses);
 *   - which models embed comes from each provider's own model metadata
 *     (Gemini `supportedGenerationMethods`, Ollama `capabilities`, LM Studio /
 *     Together `type`), falling back to ids that say "embed" (OpenAI publishes
 *     no type at all);
 *   - a model's vector size is measured by probeEmbeddingModel when it is
 *     saved.
 * The one fixed fact is Gemini's OpenAI-compatible endpoint, because Gemini is
 * configured as a native provider with no base URL of its own.
 */

const { OpenAI } = require('openai');
const { throwIfCancelled } = require('../NodeExecution/executionCancel');
const aiProviders = require('../aiProviders');

const GEMINI_OPENAI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai/';

// Every embedding call before provider choice existed used this, and only
// OpenAI was possible. It is still what an install with an OpenAI key and no
// saved embedding default gets, so upgrading changes nothing for those users.
const LEGACY_DEFAULT = { provider: 'openai', model: 'text-embedding-3-small' };

// How long Settings waits on one provider's model list.
const LIST_TIMEOUT_MS = 8000;

function normalizeEmbeddingProvider(provider) {
  const p = String(provider || '').trim().toLowerCase();
  return p === 'chatgpt' ? 'openai' : p;
}

function describeProvider(provider) {
  return aiProviders.providerLabel(normalizeEmbeddingProvider(provider));
}

/**
 * The key + base URL to embed with for `provider`, or null when it is not
 * configured, or speaks no OpenAI-compatible API (Claude).
 * @returns {{ provider, apiKey, baseURL } | null}
 */
function resolveEmbeddingEntry(provider, apiKeys = {}) {
  const p = normalizeEmbeddingProvider(provider);
  if (!p || p === 'claude') return null;
  const entry = aiProviders.resolveProviderEntry(p, apiKeys || {});
  if (!entry) return null;
  const baseURL = p === 'gemini' ? GEMINI_OPENAI_BASE_URL : (entry.baseURL || null);
  return { provider: p, apiKey: entry.apiKey || '', baseURL };
}

/**
 * Provider + model for one embedding call.
 *
 * - A node that recorded its model (built with it) keeps it. A model with no
 *   provider is from before providers were stored, when OpenAI was the only one.
 * - Otherwise the user's saved default.
 * - Otherwise, on an install with an OpenAI key, what every embedding used before.
 *
 * @returns {{ provider: string|null, model: string|null }}
 */
function resolveEmbeddingChoice({ provider, model } = {}, { apiKeys = {}, defaults = {} } = {}) {
  if (model) return { provider: normalizeEmbeddingProvider(provider) || 'openai', model };
  if (defaults.provider && defaults.model) {
    return { provider: normalizeEmbeddingProvider(defaults.provider), model: defaults.model };
  }
  if (resolveEmbeddingEntry('openai', apiKeys)) return { ...LEGACY_DEFAULT };
  return { provider: null, model: null };
}

function sdkClient(entry) {
  const opts = { apiKey: entry.apiKey || 'not-needed' };
  if (entry.baseURL) opts.baseURL = entry.baseURL;
  return new OpenAI(opts);
}

async function fetchJson(url, { apiKey, method = 'GET', body } = {}) {
  const headers = { Accept: 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(url, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(LIST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

const embedsById = (id) => /embed/i.test(String(id || ''));
const sortIds = (ids) => [...new Set(ids)].sort((a, b) => a.localeCompare(b)).map((id) => ({ value: id, label: id }));

// Typed /models entries — Together's `type: "embedding"`, LM Studio's
// `type: "embeddings"`, and `capabilities` lists/objects some servers return.
function typedEmbeddingIds(list) {
  const typed = list.filter((m) => m && (m.type || m.capabilities));
  if (typed.length === 0) return null; // the server publishes no types
  return typed.filter((m) => {
    if (/^embedding/i.test(String(m.type || ''))) return true;
    const caps = m.capabilities;
    if (Array.isArray(caps)) return caps.some((c) => /embed/i.test(String(c)));
    if (caps && typeof caps === 'object') return Object.keys(caps).some((k) => /embed/i.test(k) && caps[k]);
    return false;
  }).map((m) => m.id || m.name).filter(Boolean);
}

// Ollama's native API says per model whether it embeds (`capabilities`).
async function ollamaEmbeddingIds(root) {
  const tags = await fetchJson(`${root}/api/tags`);
  const names = (tags.models || []).map((m) => m.name || m.model).filter(Boolean);
  const shown = await Promise.all(names.map((name) =>
    fetchJson(`${root}/api/show`, { method: 'POST', body: { model: name } })
      .then((info) => ({ name, caps: info.capabilities || null }))
      .catch(() => ({ name, caps: null }))));
  if (!shown.some((s) => Array.isArray(s.caps))) return null; // older Ollama: no capabilities field
  return shown.filter((s) => Array.isArray(s.caps) && s.caps.includes('embedding')).map((s) => s.name);
}

// LM Studio's native API types every model (`llm` | `vlm` | `embeddings`).
async function lmStudioEmbeddingIds(root) {
  const body = await fetchJson(`${root}/api/v0/models`);
  return typedEmbeddingIds(body.data || []);
}

/**
 * Embedding models a provider offers — embedding models ONLY, so a picker built
 * from this cannot select a chat model. Returns `[{ value, label }]`.
 */
async function listEmbeddingModels(provider, apiKeys = {}) {
  const p = normalizeEmbeddingProvider(provider);
  const entry = resolveEmbeddingEntry(p, apiKeys);
  if (!entry) return [];

  if (p === 'gemini') {
    const body = await fetchJson(`https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000&key=${encodeURIComponent(entry.apiKey)}`);
    return (body.models || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes('embedContent'))
      .map((m) => ({ value: String(m.name || '').replace(/^models\//, ''), label: m.displayName || m.name }));
  }

  if (!entry.baseURL) {
    // OpenAI itself: /models has ids only.
    const page = await sdkClient(entry).models.list();
    return sortIds((page.data || []).map((m) => m.id).filter(embedsById));
  }

  // OpenAI-compatible server. Prefer what the server says about its models.
  const base = entry.baseURL.replace(/\/+$/, '');
  const root = base.replace(/\/v1$/i, '');
  const local = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(base);
  if (local) {
    for (const probe of [ollamaEmbeddingIds, lmStudioEmbeddingIds]) {
      try {
        const ids = await probe(root);
        if (ids) return sortIds(ids);
      } catch (_) { /* not that kind of server */ }
    }
  }
  const body = await fetchJson(`${base}/models`, { apiKey: entry.apiKey });
  const list = Array.isArray(body) ? body : (body.data || []);
  const typed = typedEmbeddingIds(list);
  return sortIds(typed || list.map((m) => m.id).filter(embedsById));
}

/**
 * Configured providers that offer at least one embedding model, with those
 * models. Discovered, not declared: a provider is listed because its own model
 * list has embedding models in it (chat-only providers simply have none).
 * @returns {Promise<Array<{ id, label, models }>>}
 */
async function listEmbeddingProviders(apiKeys = {}) {
  const ids = aiProviders.listAvailableProviders(apiKeys).filter((p) => p !== 'claude');
  const results = await Promise.all(ids.map(async (id) => {
    try {
      const models = await listEmbeddingModels(id, apiKeys);
      return models.length ? { id, label: describeProvider(id), models } : null;
    } catch (err) {
      console.warn(`[embeddings] could not list ${id} models: ${err.message}`);
      return null;
    }
  }));
  return results.filter(Boolean);
}

/** Throws unless every entry is a non-empty numeric vector. */
function assertVectors(embeddings, expected, provider, model) {
  const ok = Array.isArray(embeddings)
    && embeddings.length === expected
    && embeddings.every((v) => Array.isArray(v) && v.length > 0 && typeof v[0] === 'number');
  if (!ok) {
    throw new Error(`${describeProvider(provider)} model "${model}" did not return embedding vectors — pick an embedding model, not a chat model.`);
  }
}

/**
 * Embed raw texts. Low-level: the caller has already resolved the entry.
 * @returns {Promise<Array<Array<number>>>}
 */
async function embedTexts(texts, { provider, model, entry }) {
  const client = sdkClient(entry);
  // Under every provider's per-request input cap (Gemini: 100, OpenAI: 2048).
  const BATCH_SIZE = 100;
  const all = [];
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    // Embedding a large source is one HTTP round-trip per 100 texts — a
    // 100k-row upsert is a thousand of them, all inside a single node, and by
    // far the longest thing a vector write does. Hosted batches are also
    // billed, so stopping here stops the spend as well as the wait.
    throwIfCancelled('generating embeddings', `${all.length} of ${texts.length} embedded`);
    const batch = texts.slice(i, i + BATCH_SIZE);
    console.log(`Embedding batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(texts.length / BATCH_SIZE)} with ${provider} (${model})...`);
    const response = await client.embeddings.create({ model, input: batch, encoding_format: 'float' });
    // Some compat servers do not echo `index`; fall back to response order.
    const rows = [...(response.data || [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    all.push(...rows.map((item) => item.embedding));
  }
  return all;
}

/**
 * Embed a single probe string to prove `model` is an embedding model on
 * `provider` and measure its vector size. This is the guarantee behind the
 * Settings picker: a model is saved only once it has produced a vector.
 * @returns {Promise<{ provider, model, dimensions }>}
 */
async function probeEmbeddingModel(provider, model, apiKeys = {}) {
  const p = normalizeEmbeddingProvider(provider);
  if (!model) throw new Error('Pick an embedding model.');
  const entry = resolveEmbeddingEntry(p, apiKeys);
  if (!entry) throw new Error(`${describeProvider(p)} cannot be used for embeddings. Configure it in Settings → AI Provider.`);
  let vectors;
  try {
    vectors = await embedTexts(['Ternlux embedding check'], { provider: p, model, entry });
  } catch (err) {
    throw new Error(`${describeProvider(p)} could not embed with "${model}": ${err.message}`);
  }
  assertVectors(vectors, 1, p, model);
  return { provider: p, model, dimensions: vectors[0].length };
}

/**
 * Generate embeddings for an array of data rows
 * @param {Object} params - Parameters
 * @param {Array} params.data - Array of data rows
 * @param {String} params.columnToEmbed - Column name to extract text from
 * @param {String} params.provider - provider id (as stored with the key)
 * @param {String} params.model - Model name/ID
 * @param {String} [params.apiKey] - API key (resolved from apiKeys when omitted)
 * @param {String} [params.baseURL] - Base URL (resolved from apiKeys when omitted)
 * @param {Object} [params.apiKeys] - Decrypted provider-key map
 * @returns {Promise<Array>} Array of data rows with added 'vector' field
 */
async function generateEmbeddings({ data, columnToEmbed, provider, model, apiKey, baseURL, apiKeys }) {
  if (!data || data.length === 0) {
    throw new Error('No data provided for embedding generation');
  }

  if (!columnToEmbed) {
    throw new Error('columnToEmbed is required');
  }

  const p = normalizeEmbeddingProvider(provider);
  if (!p || !model) {
    throw new Error('No embedding model is set. Choose one in Settings → AI Provider → Default Embedding Model.');
  }

  const resolved = apiKeys ? resolveEmbeddingEntry(p, apiKeys) : null;
  if (apiKeys && !resolved && !apiKey) {
    throw new Error(`${describeProvider(p)} is not configured for embeddings. Add it in Settings → AI Provider, or choose another Default Embedding Model.`);
  }
  const entry = {
    apiKey: apiKey || resolved?.apiKey || '',
    baseURL: baseURL || resolved?.baseURL || null,
  };

  // Resolve a column that may be a flat key ("channel") or a dotted path into a
  // nested object ("properties.channel"). Prefer an exact own-key match so a
  // literal key containing a dot still works, then fall back to path traversal.
  const getByPath = (obj, pathStr) => {
    if (obj == null) return undefined;
    if (Object.prototype.hasOwnProperty.call(obj, pathStr)) return obj[pathStr];
    return pathStr.split('.').reduce(
      (acc, key) => (acc == null ? undefined : acc[key]),
      obj
    );
  };

  // Extract and validate texts from specified column
  const validRows = [];
  const texts = [];

  for (const row of data) {
    const raw = getByPath(row, columnToEmbed);
    // Accept strings directly; coerce other non-null primitives (numbers,
    // booleans) to string. Skip null/undefined, objects/arrays, and empties.
    let text = null;
    if (typeof raw === 'string') {
      text = raw;
    } else if (raw != null && typeof raw !== 'object') {
      text = String(raw);
    }
    if (text != null && text.trim().length > 0) {
      validRows.push(row);
      texts.push(text.trim());
    }
  }

  if (texts.length === 0) {
    throw new Error(`No valid text found in column: ${columnToEmbed}`);
  }

  console.log(`Generating embeddings for ${texts.length} texts using ${p} (${model})...`);

  let embeddings;
  try {
    embeddings = await embedTexts(texts, { provider: p, model, entry });
  } catch (error) {
    if (error?.cancelled) throw error;
    throw new Error(`${describeProvider(p)} embedding generation failed: ${error.message}`);
  }

  assertVectors(embeddings, texts.length, p, model);

  // Merge embeddings back with original data
  const result = validRows.map((row, idx) => ({
    ...row,
    vector: embeddings[idx],
    _embedded_column: columnToEmbed,
    _embedding_provider: p,
    _embedding_model: model,
    _embedded_at: new Date().toISOString()
  }));

  console.log(`Successfully generated ${result.length} embeddings (dimension: ${embeddings[0]?.length || 'unknown'})`);

  return result;
}

/**
 * Estimate embedding cost for OpenAI
 * @param {Array<String>} texts - Texts to estimate cost for
 * @param {String} model - OpenAI model name
 * @returns {Object} { tokens, estimatedCost }
 */
function estimateOpenAICost(texts, model = 'text-embedding-3-small') {
  // Rough estimation: ~1 token per 4 characters
  const estimatedTokens = texts.reduce((sum, text) =>
    sum + Math.ceil(text.length / 4), 0
  );

  // Pricing as of 2024 (per 1M tokens)
  const pricing = {
    'text-embedding-3-small': 0.00002,  // $0.02 per 1M tokens
    'text-embedding-3-large': 0.00013,  // $0.13 per 1M tokens
    'text-embedding-ada-002': 0.0001   // $0.10 per 1M tokens
  };

  const pricePerToken = pricing[model] || pricing['text-embedding-3-small'];
  const estimatedCost = estimatedTokens * pricePerToken;

  return {
    tokens: estimatedTokens,
    estimatedCost: estimatedCost
  };
}

module.exports = {
  normalizeEmbeddingProvider,
  resolveEmbeddingEntry,
  resolveEmbeddingChoice,
  listEmbeddingProviders,
  listEmbeddingModels,
  probeEmbeddingModel,
  embedTexts,
  generateEmbeddings,
  estimateOpenAICost,
};
