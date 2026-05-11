/**
 * Backend AI provider module (CommonJS).
 *
 * Single source of truth for SDK calls to OpenAI, Anthropic, and Gemini. The
 * renderer reaches these through the `ai:*` IPC handlers in electron.js so
 * that decrypted API keys never leave the main process.
 */

const { GoogleGenerativeAI } = require('@google/generative-ai');
const Anthropic = require('@anthropic-ai/sdk');
const OpenAI = require('openai');

const PROVIDER_PRIORITY = ['openai', 'claude', 'gemini'];

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
  const geminiModel = genAI.getGenerativeModel({
    model,
    generationConfig: { maxOutputTokens: maxTokens }
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

  const requestParams = { model, max_tokens: maxTokens, messages };
  if (systemPrompt) requestParams.system = systemPrompt;

  const message = await anthropic.messages.create(requestParams);
  if (message.content && message.content[0]?.text) {
    return stripMarkdownCodeBlocks(message.content[0].text);
  }
  throw new Error('Invalid response format from Claude API');
}

async function callOpenAI(prompt, model, maxTokens, apiKey, systemPrompt = null, chatHistory = []) {
  const OpenAICtor = OpenAI.default || OpenAI;
  const openai = new OpenAICtor({ apiKey });

  const messages = [];
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
  for (const msg of chatHistory || []) {
    messages.push({
      role: msg.sender === 'user' ? 'user' : 'assistant',
      content: msg.text
    });
  }
  messages.push({ role: 'user', content: prompt });

  const completion = await openai.chat.completions.create({
    model,
    messages,
    max_completion_tokens: maxTokens
  });
  if (completion.choices && completion.choices[0]?.message?.content) {
    return stripMarkdownCodeBlocks(completion.choices[0].message.content);
  }
  throw new Error('Invalid response format from OpenAI API');
}

/**
 * Provider-agnostic dispatcher. Caller supplies the apiKey explicitly.
 */
async function callAI(prompt, options = {}) {
  console.log('prompt: ', prompt)
  const { provider, model, maxTokens = 2048, apiKey, systemPrompt = null, chatHistory = [] } = options;
  if (!provider) throw new Error('provider is required');
  if (!apiKey) throw new Error('apiKey is required');

  const trimmedHistory = trimChatHistoryToFit({
    prompt,
    chatHistory,
    model,
    maxResponseTokens: maxTokens,
    systemPrompt
  });

  switch (provider.toLowerCase()) {
    case 'gemini':
      return callGemini(prompt, model, maxTokens, apiKey, trimmedHistory);
    case 'claude':
      return callClaude(prompt, model, maxTokens, apiKey, systemPrompt, trimmedHistory);
    case 'openai':
    case 'chatgpt':
      return callOpenAI(prompt, model, maxTokens, apiKey, systemPrompt, trimmedHistory);
    default:
      throw new Error(`Unknown AI provider: ${provider}. Supported: gemini, claude, openai`);
  }
}

function resolveApiKey(provider, apiKeys = {}) {
  if (!provider) return null;
  if (provider === 'openai' || provider === 'chatgpt') {
    return apiKeys.chatgpt || apiKeys.openai || null;
  }
  return apiKeys[provider] || null;
}

function listAvailableProviders(apiKeys = {}) {
  return PROVIDER_PRIORITY.filter((p) => !!resolveApiKey(p, apiKeys));
}

function pickProvider(apiKeys = {}, requested) {
  if (requested) {
    const key = resolveApiKey(requested, apiKeys);
    if (key) return { provider: requested === 'chatgpt' ? 'openai' : requested, apiKey: key };
  }
  for (const p of PROVIDER_PRIORITY) {
    const key = resolveApiKey(p, apiKeys);
    if (key) return { provider: p, apiKey: key };
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
    model: model || DEFAULT_MODELS[picked.provider],
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
  pickProvider,
  listAvailableProviders,
  trimChatHistoryToFit,
  estimateTokens,
  windowForModel,
  PROVIDER_PRIORITY,
  DEFAULT_MODELS,
  MODEL_CONTEXT_WINDOWS
};
