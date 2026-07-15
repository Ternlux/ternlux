/**
 * Backend AI provider module (CommonJS).
 *
 * Single source of truth for SDK calls to OpenAI, Anthropic, and Gemini. The
 * renderer reaches these through the `ai:*` IPC handlers in electron.js so
 * that decrypted API keys never leave the main process.
 */

const fs = require('fs');
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const Anthropic = require('@anthropic-ai/sdk');
const OpenAI = require('openai');

// Dev-only prompt log. Single JSON file at frontend/dev-logs/ai-prompts.json
// — reset on the first callAI invocation of each process, then re-written
// (whole array) after every log entry so the file stays valid JSON at rest.
// Disabled when NODE_ENV=production. Failures are swallowed.
const PROMPT_LOG_PATH = path.join(__dirname, '..', 'dev-logs', 'ai-prompts.json');
const promptLogEntries = [];
let promptLogInitialized = false;
function logPromptToFile(entry) {
  if (process.env.NODE_ENV === 'production') return;
  try {
    if (!promptLogInitialized) {
      fs.mkdirSync(path.dirname(PROMPT_LOG_PATH), { recursive: true });
      promptLogEntries.length = 0;
      promptLogInitialized = true;
    }
    promptLogEntries.push(entry);
    fs.writeFileSync(PROMPT_LOG_PATH, JSON.stringify(promptLogEntries, null, 2));
  } catch (_err) {
    // intentional: never propagate logging errors
  }
}

// OpenAI-compatible providers. Each exposes a `/chat/completions` endpoint that
// the `openai` SDK can drive by overriding `baseURL`, so they all route through
// callOpenAI. `requiresKey: false` providers are local servers (Ollama, LM
// Studio) that accept any non-empty key. `custom` has no fixed baseURL — the
// user supplies one in the UI, stored alongside the key.
const OPENAI_COMPAT_PROVIDERS = {
  openrouter: { label: 'OpenRouter', baseURL: 'https://openrouter.ai/api/v1', defaultModel: 'openai/gpt-4o-mini', requiresKey: true },
  groq:       { label: 'Groq',       baseURL: 'https://api.groq.com/openai/v1', defaultModel: 'llama-3.3-70b-versatile', requiresKey: true },
  together:   { label: 'Together AI', baseURL: 'https://api.together.xyz/v1', defaultModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', requiresKey: true },
  mistral:    { label: 'Mistral AI', baseURL: 'https://api.mistral.ai/v1', defaultModel: 'mistral-large-latest', requiresKey: true },
  nvidia:     { label: 'NVIDIA AI', baseURL: 'https://integrate.api.nvidia.com/v1', defaultModel: 'meta/llama-3.1-70b-instruct', requiresKey: true },
  ollama:     { label: 'Ollama',     baseURL: 'http://localhost:11434/v1', defaultModel: 'llama3.1', requiresKey: false },
  lmstudio:   { label: 'LM Studio',  baseURL: 'http://localhost:1234/v1', defaultModel: 'local-model', requiresKey: false },
  custom:     { label: 'Custom (OpenAI-compatible)', baseURL: '', defaultModel: '', requiresKey: false }
};

// Built-in providers first (preferred when several are configured), then any
// configured OpenAI-compatible provider as a fallback.
const PROVIDER_PRIORITY = ['openai', 'claude', 'gemini', ...Object.keys(OPENAI_COMPAT_PROVIDERS)];

const DEFAULT_MODELS = {
  openai: 'gpt-5.2',
  claude: 'claude-sonnet-4-5-20250929',
  gemini: 'gemini-2.0-flash'
};

// Total context window (input + output) per model, in tokens. Used to trim
// chat history before dispatching to a provider. Keys are matched exactly
// first, then by prefix (see windowForModel).
const MODEL_CONTEXT_WINDOWS = {
  // OpenAI
  'gpt-5.2': 400000,
  'gpt-5': 400000,
  'gpt-4.1': 1000000,
  'gpt-4o': 128000,
  'gpt-4o-mini': 128000,
  'gpt-4-turbo': 128000,
  'gpt-4': 8192,
  'gpt-3.5-turbo': 16385,
  // Anthropic
  'claude-sonnet-4-5-20250929': 200000,
  'claude-opus-4': 200000,
  'claude-sonnet-4': 200000,
  'claude-haiku-4': 200000,
  'claude-3-5-sonnet': 200000,
  'claude-3-5-haiku': 200000,
  'claude-3-opus': 200000,
  // Google
  'gemini-2.0-flash': 1000000,
  'gemini-1.5-pro': 2000000,
  'gemini-1.5-flash': 1000000
};

const FALLBACK_CONTEXT_WINDOW = 128000;

function windowForModel(model) {
  if (!model) return FALLBACK_CONTEXT_WINDOW;
  if (MODEL_CONTEXT_WINDOWS[model]) return MODEL_CONTEXT_WINDOWS[model];
  // Prefix match — e.g. 'claude-sonnet-4-5-20250929-preview' matches 'claude-sonnet-4-5-20250929'.
  const keys = Object.keys(MODEL_CONTEXT_WINDOWS).sort((a, b) => b.length - a.length);
  for (const key of keys) {
    if (model.startsWith(key)) return MODEL_CONTEXT_WINDOWS[key];
  }
  return FALLBACK_CONTEXT_WINDOW;
}

// Rough heuristic: ~4 chars per token for English-ish text. Good enough to
// keep us safely under provider limits; we never need exact counts here.
function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(String(text).length / 4);
}

function estimateMessageTokens(msg) {
  // Per-message overhead for role/formatting tokens that providers add.
  return estimateTokens(msg?.text || msg?.content || '') + 4;
}

/**
 * Drop oldest chat-history entries until the full request (system prompt +
 * surviving history + new prompt + reserved response tokens) fits inside the
 * model's context window.
 *
 * Throws if the new prompt alone cannot fit alongside the response budget —
 * trimming history can't rescue that case.
 *
 * @param {Object} params
 * @param {string} params.prompt              The new user prompt.
 * @param {Array}  [params.chatHistory]       Oldest-first list of {sender,text} entries.
 * @param {string} params.model               Model id used to look up the window.
 * @param {number} params.maxResponseTokens   Tokens reserved for the response.
 * @param {string} [params.systemPrompt]
 * @returns {Array} Trimmed chatHistory (a new array; input is not mutated).
 */
function trimChatHistoryToFit({ prompt, chatHistory = [], model, maxResponseTokens, systemPrompt = null }) {
  const contextWindow = windowForModel(model);
  const reserved = Number(maxResponseTokens) || 0;
  const promptTokens = estimateTokens(prompt) + 4;
  const systemTokens = systemPrompt ? estimateTokens(systemPrompt) + 4 : 0;
  const budget = contextWindow - reserved - systemTokens;

  if (promptTokens > budget) {
    const err = new Error(
      `Prompt is too long for model ${model}: needs ~${promptTokens} input tokens but only ${budget} are available ` +
      `(context window ${contextWindow}, reserved ${reserved} for response, ${systemTokens} for system prompt).`
    );
    err.code = 'PROMPT_TOO_LONG';
    throw err;
  }

  const trimmed = Array.isArray(chatHistory) ? [...chatHistory] : [];
  let historyTokens = trimmed.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
  while (trimmed.length > 0 && historyTokens + promptTokens > budget) {
    const dropped = trimmed.shift();
    historyTokens -= estimateMessageTokens(dropped);
  }
  return trimmed;
}

function stripMarkdownCodeBlocks(text) {
  if (!text) return text;
  const fenced = /^```(?:json|javascript|js)?\s*\n?([\s\S]*?)\n?```$/;
  const match = text.trim().match(fenced);
  if (match) return match[1].trim();
  const bare = /^```\s*\n?([\s\S]*?)\n?```$/;
  const bareMatch = text.trim().match(bare);
  if (bareMatch) return bareMatch[1].trim();
  return text;
}

async function callGemini(prompt, model, maxTokens, apiKey, chatHistory = []) {
  const genAI = new GoogleGenerativeAI(apiKey);
  const generationConfig = maxTokens ? { maxOutputTokens: maxTokens } : {};
  const geminiModel = genAI.getGenerativeModel({
    model,
    generationConfig
  });

  let fullPrompt = prompt;
  if (chatHistory && chatHistory.length > 0) {
    const historyText = chatHistory
      .map((msg) => `${msg.sender === 'user' ? 'User' : 'Assistant'}: ${msg.text}`)
      .join('\n');
    fullPrompt = `Previous Conversation:\n${historyText}\n\nCurrent Request:\n${prompt}`;
  }

  const result = await geminiModel.generateContent(fullPrompt);
  const response = await result.response;
  return stripMarkdownCodeBlocks(response.text());
}

async function callClaude(prompt, model, maxTokens, apiKey, systemPrompt = null, chatHistory = []) {
  const AnthropicCtor = Anthropic.default || Anthropic;
  const anthropic = new AnthropicCtor({ apiKey });

  const messages = [];
  for (const msg of chatHistory || []) {
    messages.push({
      role: msg.sender === 'user' ? 'user' : 'assistant',
      content: msg.text
    });
  }
  messages.push({ role: 'user', content: prompt });

  // Anthropic's Messages API REQUIRES max_tokens — omitting it returns a 400.
  // Always send it, defaulting when the caller didn't specify one.
  const requestParams = { model, max_tokens: maxTokens || 4096, messages };

  if (systemPrompt) requestParams.system = systemPrompt;

  const message = await anthropic.messages.create(requestParams);
  if (message.content && message.content[0]?.text) {
    return stripMarkdownCodeBlocks(message.content[0].text);
  }
  throw new Error('Invalid response format from Claude API');
}

async function callOpenAI(prompt, model, maxTokens, apiKey, systemPrompt = null, chatHistory = [], baseURL = null) {
  const OpenAICtor = OpenAI.default || OpenAI;
  // Local servers (Ollama, LM Studio) need no real key, but the SDK rejects an
  // empty apiKey — pass a placeholder when none was supplied.
  const clientOptions = { apiKey: apiKey || 'not-needed' };
  if (baseURL) clientOptions.baseURL = baseURL;
  const openai = new OpenAICtor(clientOptions);

  const messages = [];
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
  for (const msg of chatHistory || []) {
    messages.push({
      role: msg.sender === 'user' ? 'user' : 'assistant',
      content: msg.text
    });
  }
  messages.push({ role: 'user', content: prompt });

  const params = {
    model,
    messages,
  }
  // Optional for OpenAI — only send when the caller specified a cap.
  if (maxTokens) params.max_completion_tokens = maxTokens;
  const completion = await openai.chat.completions.create(params);
  if (completion.choices && completion.choices[0]?.message?.content) {
    return stripMarkdownCodeBlocks(completion.choices[0].message.content);
  }
  throw new Error('Invalid response format from OpenAI API');
}

// OpenAI exposes many non-chat models (embeddings, audio, image, moderation)
// through the same /models endpoint. Drop those so the model picker only offers
// models that chat.completions can actually drive.
const OPENAI_NON_CHAT = /(embedding|whisper|tts|audio|dall-e|moderation|image|realtime|transcribe|search|similarity|davinci|babbage|^ada|curie)/i;

/**
 * List the models a provider currently offers, via its own SDK/API — the
 * dynamic replacement for the hardcoded PROVIDER_MODELS list. Returns
 * `[{ value, label }]` (value = model id used in requests). The renderer
 * enriches these with curated descriptions and falls back to its bundled list
 * when this throws (offline, bad key, etc.).
 *
 * @param {string} provider            'claude' | 'gemini' | 'openai' | any OpenAI-compatible id
 * @param {Object} opts
 * @param {string} opts.apiKey
 * @param {string} [opts.baseURL]      Required for OpenAI-compatible providers.
 */
async function listModels(provider, { apiKey, baseURL } = {}) {
  const p = (provider || '').toLowerCase();

  if (p === 'claude') {
    const AnthropicCtor = Anthropic.default || Anthropic;
    const anthropic = new AnthropicCtor({ apiKey });
    const page = await anthropic.models.list({ limit: 1000 });
    // More recent models are returned first; preserve that order.
    return (page.data || []).map((m) => ({ value: m.id, label: m.display_name || m.id }));
  }

  if (p === 'gemini') {
    // @google/generative-ai has no list endpoint, so hit the REST models API.
    const url = `https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000&key=${encodeURIComponent(apiKey || '')}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Gemini models request failed: ${res.status} ${res.statusText}`);
    const body = await res.json();
    return (body.models || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map((m) => ({ value: String(m.name || '').replace(/^models\//, ''), label: m.displayName || m.name }));
  }

  // openai + any OpenAI-compatible provider (same /models shape).
  const OpenAICtor = OpenAI.default || OpenAI;
  const clientOptions = { apiKey: apiKey || 'not-needed' };
  if (baseURL) clientOptions.baseURL = baseURL;
  const openai = new OpenAICtor(clientOptions);
  const page = await openai.models.list();
  const models = (page.data || [])
    .map((m) => ({ value: m.id, label: m.id }))
    .filter((m) => !OPENAI_NON_CHAT.test(m.value));
  models.sort((a, b) => a.value.localeCompare(b.value));
  return models;
}

/**
 * Provider-agnostic dispatcher. Caller supplies the apiKey explicitly.
 */
async function callAI(prompt, options = {}) {
  const { provider, model, maxTokens, apiKey, systemPrompt = null, chatHistory = [], baseURL = null } = options;
  if (!provider) throw new Error('provider is required');
  const compatConf = OPENAI_COMPAT_PROVIDERS[provider.toLowerCase()];
  // Keyless OpenAI-compatible providers (local servers) may run without a key.
  if (!apiKey && (!compatConf || compatConf.requiresKey)) throw new Error('apiKey is required');

  const trimmedHistory = trimChatHistoryToFit({
    prompt,
    chatHistory,
    model,
    maxResponseTokens: maxTokens ? maxTokens : 4096,
    systemPrompt
  });

  const requestEntry = {
    kind:        'request',
    ts:          new Date().toISOString(),
    provider,
    model:       model || null,
    maxTokens,
    systemPrompt,
    chatHistory: trimmedHistory,
    prompt,
  };
  logPromptToFile(requestEntry);


  let response;
  let callError = null;
  try {
    switch (provider.toLowerCase()) {
      case 'gemini':
        response = await callGemini(prompt, model, maxTokens, apiKey, trimmedHistory);
        break;
      case 'claude':
        response = await callClaude(prompt, model, maxTokens, apiKey, systemPrompt, trimmedHistory);
        break;
      case 'openai':
      case 'chatgpt':
        response = await callOpenAI(prompt, model, maxTokens, apiKey, systemPrompt, trimmedHistory);
        break;
      default: {
        // Any OpenAI-compatible provider (OpenRouter, Groq, Together, Mistral,
        // Ollama, LM Studio, custom) routes through the OpenAI SDK + baseURL.
        if (!compatConf) {
          throw new Error(`Unknown AI provider: ${provider}. Supported: gemini, claude, openai, ${Object.keys(OPENAI_COMPAT_PROVIDERS).join(', ')}`);
        }
        const url = baseURL || compatConf.baseURL;
        if (!url) throw new Error(`Provider "${provider}" requires a base URL. Set one in AI provider settings.`);
        if (!model) throw new Error(`Provider "${provider}" requires a model name.`);
        response = await callOpenAI(prompt, model, maxTokens, apiKey, systemPrompt, trimmedHistory, url);
        break;
      }
    }
  } catch (err) {
    callError = err;
  }

  // Response goes first so it sits ABOVE the matching request in the file
  // (the file is read top→bottom, append-only).
  logPromptToFile({
    kind:     'response',
    ts:       new Date().toISOString(),
    provider,
    model:    model || null,
    ...(callError ? { error: callError.message } : { response }),
  });

  if (callError) throw callError;
  return response;
}

/**
 * Resolve a provider's stored configuration into a normalized entry the
 * dispatcher can use: { apiKey, baseURL?, model? }, or null if the provider
 * isn't usable (no key for a key-requiring provider, or a custom provider with
 * no base URL configured).
 *
 * OpenAI-compatible providers may be stored either as a plain key string or as
 * an object { apiKey, baseURL, model } so the UI can carry a per-provider base
 * URL and model. A provider is only considered configured if it has a stored
 * entry — keyless local providers are NOT auto-enabled.
 */
function resolveProviderEntry(provider, apiKeys = {}) {
  if (!provider) return null;
  const p = provider.toLowerCase();

  if (p === 'openai' || p === 'chatgpt') {
    const key = apiKeys.chatgpt || apiKeys.openai;
    return key ? { apiKey: key } : null;
  }
  if (p === 'claude' || p === 'gemini') {
    return apiKeys[p] ? { apiKey: apiKeys[p] } : null;
  }

  const conf = OPENAI_COMPAT_PROVIDERS[p];
  if (conf) {
    const stored = apiKeys[p];
    if (!stored) return null; // never auto-enable a compat provider
    const entry = typeof stored === 'object' ? stored : { apiKey: stored };
    const apiKey = entry.apiKey || entry.key || '';
    const baseURL = entry.baseURL || conf.baseURL || '';
    const model = entry.model || conf.defaultModel || undefined;
    if (conf.requiresKey && !apiKey) return null;
    if (!baseURL) return null; // custom provider needs a URL
    return { apiKey, baseURL, model };
  }
  return null;
}

// Backward-compatible helper: just the API key string (or null).
function resolveApiKey(provider, apiKeys = {}) {
  const entry = resolveProviderEntry(provider, apiKeys);
  return entry ? (entry.apiKey || null) : null;
}

function listAvailableProviders(apiKeys = {}) {
  return PROVIDER_PRIORITY.filter((p) => !!resolveProviderEntry(p, apiKeys));
}

function pickProvider(apiKeys = {}, requested) {
  if (requested) {
    const entry = resolveProviderEntry(requested, apiKeys);
    if (entry) {
      const provider = requested.toLowerCase() === 'chatgpt' ? 'openai' : requested.toLowerCase();
      return { provider, ...entry };
    }
  }
  for (const p of PROVIDER_PRIORITY) {
    const entry = resolveProviderEntry(p, apiKeys);
    if (entry) return { provider: p, ...entry };
  }
  return null;
}

/**
 * Higher-level dispatcher for callers that hold the full apiKeys map.
 *
 * @param {string} prompt
 * @param {Object} options
 * @param {Object} options.apiKeys     Decrypted keys (e.g. from loadApiKeys()).
 * @param {string} [options.provider]  Preferred provider; falls back to first available.
 * @param {string} [options.model]
 * @param {number} [options.maxTokens]
 * @param {string} [options.systemPrompt]
 * @param {Array}  [options.chatHistory]
 */
async function callAIWithKeys(prompt, options = {}) {
  const { apiKeys = {}, provider: requestedProvider, model, maxTokens, systemPrompt, chatHistory } = options;
  const picked = pickProvider(apiKeys, requestedProvider);
  if (!picked) {
    throw new Error('No AI provider available. Configure an API key for openai, claude, or gemini.');
  }
  return callAI(prompt, {
    provider: picked.provider,
    apiKey: picked.apiKey,
    baseURL: picked.baseURL,
    model: model || picked.model || DEFAULT_MODELS[picked.provider],
    maxTokens,
    systemPrompt,
    chatHistory
  });
}

module.exports = {
  stripMarkdownCodeBlocks,
  callGemini,
  callClaude,
  callOpenAI,
  callAI,
  callAIWithKeys,
  listModels,
  pickProvider,
  resolveProviderEntry,
  resolveApiKey,
  listAvailableProviders,
  trimChatHistoryToFit,
  estimateTokens,
  windowForModel,
  PROVIDER_PRIORITY,
  DEFAULT_MODELS,
  MODEL_CONTEXT_WINDOWS,
  OPENAI_COMPAT_PROVIDERS
};
