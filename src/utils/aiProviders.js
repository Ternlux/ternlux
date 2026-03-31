/**
 * AI Provider utility for making requests to Gemini, Claude, and OpenAI APIs
 * Uses official SDKs for each provider
 * API keys are managed through apiKeyStorage.js
 *
 * Required packages:
 * npm install @google/generative-ai @anthropic-ai/sdk openai
 */

import { GoogleGenerativeAI } from '@google/generative-ai';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { loadApiKey, hasApiKeyForProvider, getConfiguredProviderName } from './apiKeyStorage';
import AI_CONFIG from '../config/aiProviders.json';

/**
 * Strip markdown code blocks from response text
 * Removes ```json, ```, and similar markdown formatting
 * @param {string} text - The text that might contain markdown code blocks
 * @returns {string} - Clean text without markdown code blocks
 */
const stripMarkdownCodeBlocks = (text) => {
  if (!text) return text;

  // Check if text is wrapped in markdown code blocks
  const codeBlockPattern = /^```(?:json|javascript|js)?\s*\n?([\s\S]*?)\n?```$/;
  const match = text.trim().match(codeBlockPattern);

  if (match) {
    // Return the content inside the code block
    return match[1].trim();
  }

  // Also handle inline code blocks without language specifier
  const simpleCodeBlockPattern = /^```\s*\n?([\s\S]*?)\n?```$/;
  const simpleMatch = text.trim().match(simpleCodeBlockPattern);

  if (simpleMatch) {
    return simpleMatch[1].trim();
  }

  // No code blocks found, return original text
  return text;
};

// Get first model for each provider from config
const getDefaultModel = (provider) => {
  const models = AI_CONFIG.PROVIDER_MODELS[provider];
  return models && models.length > 0 ? models[0].value : null;
};

/**
 * Load provider settings from localStorage with fallback to first available provider
 * @returns {Promise<Object|null>} - Provider settings { provider, model, maxTokens }
 */
const getProviderSettings = async () => {
  try {
    // Try to load saved settings
    const savedSettings = localStorage.getItem('ai-provider-settings');
    if (savedSettings) {
      const settings = JSON.parse(savedSettings);
      // Verify this provider has a key
      const hasKey = await hasApiKeyForProvider(settings.provider);
      if (hasKey) {
        return settings;
      }
    }

    // Fallback: find first provider that has a key
    const providers = Object.keys(AI_CONFIG.PROVIDER_MODELS);
    for (const provider of providers) {
      const hasKey = await hasApiKeyForProvider(provider);
      if (hasKey) {
        return {
          provider,
          model: getDefaultModel(provider),
          maxTokens: 2048
        };
      }
    }

    return null;
  } catch (error) {
    console.error('Error loading provider settings:', error);
    return null;
  }
};

/**
 * Get the API key for a specific provider from apiKeyStorage
 * @param {string} requestedProvider - The provider to get the key for ('gemini', 'claude', 'openai')
 * @returns {Promise<string>} - The API key
 * @throws {Error} - If no API key is configured for the provider
 */
const getApiKeyForProvider = async (requestedProvider) => {
  // Map provider names (we use 'openai' but storage uses 'chatgpt')
  const providerMap = {
    'openai': 'chatgpt',
    'gemini': 'gemini',
    'claude': 'claude',
    'chatgpt': 'chatgpt'
  };

  const storageProviderName = providerMap[requestedProvider.toLowerCase()] || requestedProvider.toLowerCase();

  // Load the key for this specific provider
  const apiKey = await loadApiKey(storageProviderName);

  if (!apiKey) {
    throw new Error(`No API key configured for ${requestedProvider}. Please set up your API key in settings.`);
  }

  return apiKey;
};

/**
 * Make a request to Google Gemini API
 * @param {string} prompt - The prompt to send to Gemini
 * @param {string} model - Model to use
 * @param {number} maxTokens - Max tokens for response
 * @param {string} apiKey - API key
 * @param {Array} chatHistory - Optional chat history array
 * @returns {Promise<string>} - The response text from Gemini
 */
export const callGemini = async (prompt, model, maxTokens, apiKey, chatHistory = []) => {
  try {
    // Initialize Gemini SDK
    const genAI = new GoogleGenerativeAI(apiKey);
    const geminiModel = genAI.getGenerativeModel({
      model,
      generationConfig: {
        maxOutputTokens: maxTokens,
      }
    });

    // Build the full prompt with chat history
    let fullPrompt = prompt;
    if (chatHistory && chatHistory.length > 0) {
      const historyText = chatHistory
        .map(msg => {
          const role = msg.sender === 'user' ? 'User' : 'Assistant';
          return `${role}: ${msg.text}`;
        })
        .join('\n');
      fullPrompt = `Previous Conversation:\n${historyText}\n\nCurrent Request:\n${prompt}`;
    }

    // Generate content
    const result = await geminiModel.generateContent(fullPrompt);
    const response = await result.response;
    const text = response.text();

    return stripMarkdownCodeBlocks(text);
  } catch (error) {
    console.error('Error calling Gemini API:', error);
    throw new Error(`Failed to call Gemini API: ${error.message}`);
  }
};

/**
 * Make a request to Anthropic Claude API
 * @param {string} prompt - The prompt to send to Claude
 * @param {string} model - Model to use
 * @param {number} maxTokens - Max tokens for response
 * @param {string} apiKey - API key
 * @param {string} systemPrompt - Optional system prompt
 * @param {Array} chatHistory - Optional chat history array
 * @returns {Promise<string>} - The response text from Claude
 */
export const callClaude = async (prompt, model, maxTokens, apiKey, systemPrompt = null, chatHistory = []) => {
  try {
    // Initialize Anthropic SDK
    const anthropic = new Anthropic({
      apiKey,
      dangerouslyAllowBrowser: true // Required for browser usage
    });

    // Build messages array with chat history
    const messages = [];

    // Add chat history if provided
    if (chatHistory && chatHistory.length > 0) {
      chatHistory.forEach(msg => {
        messages.push({
          role: msg.sender === 'user' ? 'user' : 'assistant',
          content: msg.text
        });
      });
    }

    // Add current prompt
    messages.push({
      role: 'user',
      content: prompt
    });

    const requestParams = {
      model,
      max_tokens: maxTokens,
      messages
    };

    // Add system prompt if provided
    if (systemPrompt) {
      requestParams.system = systemPrompt;
    }

    // Create message
    const message = await anthropic.messages.create(requestParams);

    // Extract text from response
    if (message.content && message.content[0]?.text) {
      return stripMarkdownCodeBlocks(message.content[0].text);
    } else {
      throw new Error('Invalid response format from Claude API');
    }
  } catch (error) {
    console.error('Error calling Claude API:', error);
    throw new Error(`Failed to call Claude API: ${error.message}`);
  }
};

/**
 * Make a request to OpenAI API
 * @param {string} prompt - The prompt to send to OpenAI
 * @param {string} model - Model to use
 * @param {number} maxTokens - Max tokens for response
 * @param {string} apiKey - API key
 * @param {string} systemPrompt - Optional system prompt
 * @param {Array} chatHistory - Optional chat history array
 * @returns {Promise<string>} - The response text from OpenAI
 */
export const callOpenAI = async (prompt, model, maxTokens, apiKey, systemPrompt = null, chatHistory = []) => {
  try {
    // Initialize OpenAI SDK
    const openai = new OpenAI({
      apiKey,
      dangerouslyAllowBrowser: true // Required for browser usage
    });

    const messages = [];

    // Add system prompt if provided
    if (systemPrompt) {
      messages.push({
        role: 'system',
        content: systemPrompt
      });
    }

    // Add chat history if provided
    if (chatHistory && chatHistory.length > 0) {
      chatHistory.forEach(msg => {
        messages.push({
          role: msg.sender === 'user' ? 'user' : 'assistant',
          content: msg.text
        });
      });
    }

    // Add current prompt
    messages.push({
      role: 'user',
      content: prompt
    });

    // Create chat completion
    const completion = await openai.chat.completions.create({
      model,
      messages,
      max_completion_tokens: maxTokens
    });

    // Extract text from response
    if (completion.choices && completion.choices[0]?.message?.content) {
      return stripMarkdownCodeBlocks(completion.choices[0].message.content);
    } else {
      throw new Error('Invalid response format from OpenAI API');
    }
  } catch (error) {
    console.error('Error calling OpenAI API:', error);
    throw new Error(`Failed to call OpenAI API: ${error.message}`);
  }
};

/**
 * Unified function to call any AI provider
 * Auto-detects provider settings and API key, with fallback to first available provider
 * @param {string} prompt - The prompt to send
 * @param {Object} options - Optional overrides { provider, model, maxTokens, systemPrompt, chatHistory }
 * @returns {Promise<string>} - The response text from the selected provider
 */
export const callAI = async (prompt, options = {}) => {
  try {
    // Get settings (with fallback to first available provider)
    const settings = await getProviderSettings();
    if (!settings) {
      throw new Error('No AI provider configured. Please set up your API key in settings.');
    }

    // Use provided options or fallback to configured settings
    const useProvider = options.provider || settings.provider;
    const model = options.model || settings.model;
    const maxTokens = options.maxTokens || settings.maxTokens;
    const systemPrompt = options.systemPrompt || null;
    const chatHistory = options.chatHistory || [];

    // Get API key for this provider
    const apiKey = await getApiKeyForProvider(useProvider);
    console.log('apiKey: ', useProvider, prompt, chatHistory)
    // Route to appropriate provider function
    const normalizedProvider = useProvider.toLowerCase();
    switch (normalizedProvider) {
      case 'gemini':
        return callGemini(prompt, model, maxTokens, apiKey, chatHistory);

      case 'claude':
        return callClaude(prompt, model, maxTokens, apiKey, systemPrompt, chatHistory);

      case 'openai':
        return callOpenAI(prompt, model, maxTokens, apiKey, systemPrompt, chatHistory);

      default:
        throw new Error(`Unknown AI provider: ${useProvider}. Supported providers: gemini, claude, openai`);
    }
  } catch (error) {
    console.error('Error calling AI:', error);
    throw error;
  }
};

/**
 * Get the current configuration for an AI provider
 * @param {string} provider - The AI provider name
 * @returns {Promise<Object|null>} - The provider configuration (model info, settings)
 */
export const getProviderConfig = async (provider) => {
  const normalizedProvider = provider.toLowerCase();

  // Try to get saved settings first
  const savedSettings = await getProviderSettings();
  if (savedSettings && savedSettings.provider === normalizedProvider) {
    return {
      model: savedSettings.model,
      maxTokens: savedSettings.maxTokens
    };
  }

  // Fall back to default from config
  const defaultModel = getDefaultModel(normalizedProvider);
  if (defaultModel) {
    return {
      model: defaultModel,
      maxTokens: 2048
    };
  }

  return null;
};

/**
 * Check if an API key is configured for a provider
 * @param {string} provider - The AI provider name ('gemini', 'claude', 'openai')
 * @returns {Promise<boolean>} - Whether the API key is configured for this provider
 */
export const isProviderConfigured = async (provider) => {
  // Use safe helper that doesn't expose key value
  return await hasApiKeyForProvider(provider);
};

/**
 * Get the currently configured provider from storage
 * @returns {Promise<string|null>} - The configured provider name or null
 */
export const getConfiguredProvider = async () => {
  try {
    // Use safe helper that doesn't expose key value
    const providerName = await getConfiguredProviderName();
    if (!providerName) {
      return null;
    }

    // Map provider names (apiKeyStorage uses 'chatgpt', we use 'openai')
    const providerMap = {
      'chatgpt': 'openai',
      'gemini': 'gemini',
      'claude': 'claude'
    };

    return providerMap[providerName.toLowerCase()] || providerName.toLowerCase();
  } catch (error) {
    return null;
  }
};

/**
 * Get list of all supported providers
 * @returns {Array<string>} - Array of provider names
 */
export const getSupportedProviders = () => {
  return Object.keys(AI_CONFIG.PROVIDER_MODELS);
};

export default {
  callGemini,
  callClaude,
  callOpenAI,
  callAI,
  getProviderConfig,
  isProviderConfigured,
  getConfiguredProvider,
  getSupportedProviders
};
