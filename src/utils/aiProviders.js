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

function readSavedSettings() {
  try {
    const raw = localStorage.getItem(PROVIDER_SETTINGS_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    console.warn('[aiProviders] Could not read provider settings:', e);
    return null;
  }
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
  const merged = {
    provider: options.provider || saved.provider,
    model: options.model || saved.model,
    maxTokens: options.maxTokens || saved.maxTokens || 2048,
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
  getSupportedProviders
};
