/**
 * Renderer-side AI provider wrapper.
 *
 * The actual SDK calls and decrypted API keys live in the main process
 * (public/aiProviders.js); this file is a thin pass-through that adds the
 * browser-only concerns of reading the user's preferred provider/model from
 * localStorage and forwarding them to the `ai:*` IPC handlers.
 */

import { hasApiKeyForProvider, getConfiguredProviderName } from './apiKeyStorage';

const PROVIDER_SETTINGS_KEY = 'ai-provider-settings';

// OpenAI-compatible providers reachable via the OpenAI SDK + a custom baseURL.
// Mirrors OPENAI_COMPAT_PROVIDERS in public/aiProviders.js. The base URL and
// model for these live in the encrypted key entry (set in provider settings),
// so the renderer only needs to forward the provider id — the main process
// resolves the rest. `null` baseURL means the user supplies it (custom).
export const OPENAI_COMPAT_PROVIDERS = {
  openrouter: { name: 'OpenRouter', baseURL: 'https://openrouter.ai/api/v1', requiresKey: true, color: '#6566F1', placeholderModel: 'openai/gpt-4o-mini', docsUrl: 'https://openrouter.ai/keys' },
  groq:       { name: 'Groq',       baseURL: 'https://api.groq.com/openai/v1', requiresKey: true, color: '#F55036', placeholderModel: 'llama-3.3-70b-versatile', docsUrl: 'https://console.groq.com/keys' },
  together:   { name: 'Together AI', baseURL: 'https://api.together.xyz/v1', requiresKey: true, color: '#0F6FFF', placeholderModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', docsUrl: 'https://api.together.xyz/settings/api-keys' },
  mistral:    { name: 'Mistral AI', baseURL: 'https://api.mistral.ai/v1', requiresKey: true, color: '#FA520F', placeholderModel: 'mistral-large-latest', docsUrl: 'https://console.mistral.ai/api-keys' },
  nvidia:     { name: 'NVIDIA AI', baseURL: 'https://integrate.api.nvidia.com/v1', requiresKey: true, color: '#76B900', placeholderModel: 'meta/llama-3.1-70b-instruct', docsUrl: 'https://build.nvidia.com/' },
  ollama:     { name: 'Ollama',     baseURL: 'http://localhost:11434/v1', requiresKey: false, color: '#000000', placeholderModel: 'llama3.1', docsUrl: 'https://ollama.com/download' },
  lmstudio:   { name: 'LM Studio',  baseURL: 'http://localhost:1234/v1', requiresKey: false, color: '#4B5563', placeholderModel: 'local-model', docsUrl: 'https://lmstudio.ai/docs/local-server' },
  custom:     { name: 'Custom (OpenAI-compatible)', baseURL: '', requiresKey: false, color: '#8C8C8C', placeholderModel: '', docsUrl: '' }
};

export function isOpenAICompatProvider(provider) {
  return !!provider && Object.prototype.hasOwnProperty.call(OPENAI_COMPAT_PROVIDERS, String(provider).toLowerCase());
}

function readSavedSettings() {
  try {
    const raw = localStorage.getItem(PROVIDER_SETTINGS_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    console.warn('[aiProviders] Could not read provider settings:', e);
    return null;
  }
}

// ── Max Tokens ─────────────────────────────────────────────────────────────
// The user's choice is the primary value everywhere; this static ladder only
// supplies the options and the fallback when nothing is saved yet.
export const DEFAULT_MAX_TOKENS = 16000;
const TOKEN_LADDER = [2048, 4096, 8192, 16000, 32000, 64000, 128000];

/**
 * Max Tokens choices for a model, filtered to what it actually accepts.
 * `cap` is the model's published output limit (from ai.listModels); without
 * one the full ladder is offered and the provider rejects what it can't serve.
 */
export function buildTokenOptions(cap) {
  const options = (cap ? TOKEN_LADDER.filter((n) => n < cap) : TOKEN_LADDER).map((n) => ({
    value: n,
    label: `${n.toLocaleString()}${n === DEFAULT_MAX_TOKENS ? ' - Recommended' : ''}`,
  }));
  if (cap) options.push({ value: cap, label: `${cap.toLocaleString()} - Model maximum` });
  return options;
}

/** The user's saved Max Tokens, or the static fallback. */
export function getMaxTokens() {
  return readSavedSettings()?.maxTokens || DEFAULT_MAX_TOKENS;
}

/**
 * Persist Max Tokens for both worlds: localStorage (renderer calls) and the
 * main-process prefs file (backend calls — chat, planner, titles), so one
 * setting governs every AI call. `cap` clamps to the model's published limit.
 */
export async function saveMaxTokens(maxTokens, cap = null) {
  const value = cap ? Math.min(maxTokens, cap) : maxTokens;
  try {
    const current = JSON.parse(localStorage.getItem(PROVIDER_SETTINGS_KEY) || '{}');
    localStorage.setItem(PROVIDER_SETTINGS_KEY, JSON.stringify({
      ...current, maxTokens: value, updatedAt: new Date().toISOString(),
    }));
  } catch (e) {
    console.warn('[aiProviders] Could not save max tokens:', e);
  }
  try {
    await window.electronAPI?.ai?.setMaxTokens?.(value);
  } catch (e) {
    console.warn('[aiProviders] Could not persist max tokens to main:', e);
  }
  return value;
}

/**
 * Call any configured AI provider via IPC. Provider/model defaults come from
 * the user's saved UI settings; explicit options override them.
 *
 * @param {string} prompt
 * @param {Object} [options]
 * @param {string} [options.provider]
 * @param {string} [options.model]
 * @param {number} [options.maxTokens]
 * @param {string} [options.systemPrompt]
 * @param {Array}  [options.chatHistory]
 * @returns {Promise<string>}
 */
export async function callAI(prompt, options = {}) {
  const saved = readSavedSettings() || {};
  // The user-chosen default provider wins over the last-configured one.
  const provider = options.provider || saved.defaultProvider || saved.provider;
  const merged = {
    provider,
    // saved.model belongs to saved.provider; for any other provider let the
    // main process fall back to that provider's default model. For OpenAI-
    // compatible providers the model + baseURL live in the encrypted key entry,
    // so the main process resolves them — we only forward an explicit override.
    model: options.model || (provider === saved.provider ? saved.model : undefined),
    ...(options.baseURL ? { baseURL: options.baseURL } : {}),
    maxTokens: options.maxTokens || saved.maxTokens || DEFAULT_MAX_TOKENS,
    systemPrompt: options.systemPrompt || null,
    chatHistory: options.chatHistory || []
  };

  const result = await window.electronAPI.ai.call({ prompt, options: merged });
  if (!result || !result.success) {
    throw new Error(result?.message || 'AI call failed');
  }
  return result.text;
}

/**
 * Get the user's currently configured provider, normalized to renderer naming.
 */
export async function getConfiguredProvider() {
  try {
    const providerName = await getConfiguredProviderName();
    if (!providerName) return null;
    // apiKeyStorage uses 'chatgpt'; we expose 'openai' to the rest of the app.
    return providerName.toLowerCase() === 'chatgpt' ? 'openai' : providerName.toLowerCase();
  } catch (e) {
    console.error('[aiProviders] getConfiguredProvider failed:', e);
    return null;
  }
}

export async function isProviderConfigured(provider) {
  return hasApiKeyForProvider(provider);
}

export async function getSupportedProviders() {
  try {
    const result = await window.electronAPI.ai.listProviders();
    return result?.providers || [];
  } catch (e) {
    return [];
  }
}

export default {
  callAI,
  getConfiguredProvider,
  isProviderConfigured,
  getSupportedProviders,
  OPENAI_COMPAT_PROVIDERS,
  isOpenAICompatProvider
};
