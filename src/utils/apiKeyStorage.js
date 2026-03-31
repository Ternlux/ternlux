/**
 * Unified API key storage utility.
 *
 * In Electron the key is encrypted with OS safeStorage (keychain / Credential
 * Store) via the main process. In a plain browser (e.g. `npm start` without
 * Electron) we fall back to localStorage so the dev workflow stays smooth.
 */

const LS_PROVIDER = 'dagflux_llm_provider';
const LS_KEY = 'dagflux_llm_key';

function isElectron() {
  return typeof window !== 'undefined' && typeof window.electronAPI !== 'undefined';
}

/**
 * Persist the selected provider and its API key securely.
 *
 * @param {string} provider - 'claude' | 'gemini' | 'chatgpt'
 * @param {string} key      - Raw API key string
 * @returns {Promise<{success: boolean, error?: string}>}
 */
export async function saveApiKey(provider, key) {
  if (isElectron()) {
    return window.electronAPI.saveApiKey(provider, key);
  }
  return { success: true };
}

/**
 * Load the API key for a specific provider.
 *
 * @param {string} provider - 'claude' | 'gemini' | 'chatgpt'
 * @returns {Promise<string | null>} - The API key for that provider or null
 */
export async function loadApiKey(provider) {
  if (isElectron()) {
    const allKeys = await window.electronAPI.loadApiKey();
    if (!allKeys) return null;
    return allKeys[provider] || null;
  }


  return null;
}

/**
 * Remove the stored API key (triggers setup screen on next load).
 *
 * @returns {Promise<{success: boolean}>}
 */
export async function clearApiKey() {
  if (isElectron()) {
    return window.electronAPI.clearApiKey();
  }
  return { success: true };
}

/**
 * Check if an API key exists for a specific provider WITHOUT exposing the key value.
 *
 * @param {string} requestedProvider - 'claude' | 'gemini' | 'openai' | 'chatgpt'
 * @returns {Promise<boolean>} - true if a key exists for this provider
 */
export async function hasApiKeyForProvider(requestedProvider) {
  try {
    // Map provider names (we accept both 'openai' and 'chatgpt')
    const providerMap = {
      'chatgpt': 'chatgpt',
      'gemini': 'gemini',
      'claude': 'claude',
      'openai': 'chatgpt' // openai maps to chatgpt in storage
    };
    // console.log('requestedProvider: ', requestedProvider)

    const normalizedProvider = providerMap[requestedProvider.toLowerCase()] || requestedProvider.toLowerCase();

    if (isElectron()) {
      const allKeys = await window.electronAPI.loadApiKey();
      // console.log('allKeys: ', allKeys)
      if (!allKeys) return false;
      return !!(allKeys[normalizedProvider]);
    }

  } catch (error) {
    console.error('Error checking API key for provider:', error);
    return false;
  }
}

/**
 * Check if ANY API key is configured (regardless of provider).
 *
 * @returns {Promise<boolean>} - true if any key exists
 */
export async function hasAnyApiKey() {
  try {
    if (isElectron()) {
      const allKeys = await window.electronAPI.loadApiKey();
      if (!allKeys) return false;
      // Check if there's at least one key
      return Object.keys(allKeys).length > 0;
    }

    // Browser fallback
    const provider = localStorage.getItem(LS_PROVIDER);
    const key = localStorage.getItem(LS_KEY);
    return !!(provider && key);
  } catch (error) {
    console.error('Error checking for any API key:', error);
    return false;
  }
}

/**
 * Get the active/selected provider name from settings (NOT from stored keys).
 * This is the provider the user has chosen to use in the settings UI.
 *
 * @returns {Promise<string|null>} - The provider name ('claude' | 'gemini' | 'chatgpt') or null
 */
export async function getConfiguredProviderName() {
  try {
    // Read from ai-provider-settings (localStorage)
    const savedSettings = localStorage.getItem('ai-provider-settings');
    if (savedSettings) {
      const settings = JSON.parse(savedSettings);
      return settings.provider || null;
    }

    // Fallback: if no settings, return first provider that has a key
    if (isElectron()) {
      const allKeys = await window.electronAPI.loadApiKey();
      if (allKeys && Object.keys(allKeys).length > 0) {
        return Object.keys(allKeys)[0];
      }
    } else {
      // Browser fallback
      const provider = localStorage.getItem(LS_PROVIDER);
      return provider || null;
    }

    return null;
  } catch (error) {
    console.error('Error getting configured provider name:', error);
    return null;
  }
}
