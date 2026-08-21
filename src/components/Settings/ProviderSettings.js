import React, { useState, useEffect } from 'react';
import { Form, Select, AutoComplete, Card, Button, message, Divider, Typography, Space, Alert } from 'antd';
import { RobotOutlined, CheckCircleOutlined, SaveOutlined, EditOutlined } from '@ant-design/icons';
import ProviderKeyForm from '../ApiKeySetup/ProviderKeyForm';
import OthersProviderForm from '../ApiKeySetup/OthersProviderForm';
import { hasApiKeyForProvider } from '../../utils/apiKeyStorage';
import {
  OPENAI_COMPAT_PROVIDERS,
  DEFAULT_MAX_TOKENS,
  buildTokenOptions,
  saveMaxTokens,
} from '../../utils/aiProviders';
import AI_CONFIG from '../../config/aiProviders.json';

const { Option } = Select;
const { Title, Text, Paragraph } = Typography;

// Import from JSON config. Model lists are fetched live from each provider's
// SDK (see loadModels); PROVIDER_MODELS only survives as an optional curated
// overlay (label/description/"Recommended") and is empty by default.
const PROVIDER_MODELS = AI_CONFIG.PROVIDER_MODELS || {};
const PROVIDER_INFO = AI_CONFIG.PROVIDER_INFO;

// OpenAI-compatible provider ids (the "Others" group).
const COMPAT_IDS = Object.keys(OPENAI_COMPAT_PROVIDERS);

// Built-in providers plus every OpenAI-compatible provider — used to detect
// which providers already have a key/config stored.
const PROVIDER_IDS = ['gemini', 'claude', 'openai', ...COMPAT_IDS];

// Display name + accent color for any provider id (built-in or compat).
const getProviderInfo = (id) =>
  PROVIDER_INFO[id] ||
  (OPENAI_COMPAT_PROVIDERS[id]
    ? { name: OPENAI_COMPAT_PROVIDERS[id].name, color: OPENAI_COMPAT_PROVIDERS[id].color }
    : { name: id, color: '#8c8c8c' });

// Merge a live SDK model list with the bundled curated metadata. The model ids
// come from the provider's API (so new models appear automatically); the
// curated label/description are layered on when an id matches, otherwise we
// synthesize a label from the id. Always returns objects with a string
// `description` so the dropdown's `.includes('Recommended')` check is safe.
const enrichModels = (provider, liveModels) => {
  const curated = PROVIDER_MODELS[provider] || [];
  const byValue = new Map(curated.map((m) => [m.value, m]));
  return (liveModels || []).map((m) => {
    const match = byValue.get(m.value);
    return {
      value: m.value,
      label: match?.label || m.label || m.value,
      description: match?.description || '',
      // Published by the provider's models endpoint (Anthropic, Google); null
      // for providers that don't expose limits (OpenAI) and for bundled entries.
      maxOutputTokens: m.maxOutputTokens || null,
      maxInputTokens: m.maxInputTokens || null,
    };
  });
};


const ProviderSettings = () => {
  const [form] = Form.useForm();
  const [selectedProvider, setSelectedProvider] = useState('claude');
  // The provider every AI feature actually uses. The model + Max Tokens shown
  // in the "Default AI Provider" card belong to THIS provider, not to whichever
  // one is open in the "Configure Provider" section below (that section only
  // manages API keys).
  const [defaultProvider, setDefaultProviderValue] = useState(null);
  const [savingDefault, setSavingDefault] = useState(false);
  const [hasApiKey, setHasApiKey] = useState(false);
  const [providerHasKey, setProviderHasKey] = useState(true); // Track if selected provider has key
  const [changingKey, setChangingKey] = useState(false); // Replace-key form for a provider that already has one
  const [configuredProviders, setConfiguredProviders] = useState([]); // Providers that have an API key
  const [models, setModels] = useState([]); // Model options for the selected provider (live SDK list)
  const [modelsLoading, setModelsLoading] = useState(false);

  // Load saved settings on mount
  useEffect(() => {
    loadSettings();
    initSelectedProvider();
    checkApiKey();
    refreshConfiguredProviders();
    reconcileDefaultProvider();
  }, []);

  // Resolve which provider panel to open on when localStorage has no explicit
  // selection or default — so Settings reflects the actually-configured provider
  // instead of always showing Claude (and its false "No API Key" warning). Only
  // runs when loadSettings couldn't resolve from localStorage; falls back to the
  // main-process default provider, then the first provider that has a saved key.
  const initSelectedProvider = async () => {
    try {
      let saved = {};
      try { saved = JSON.parse(localStorage.getItem('ai-provider-settings') || '{}'); } catch (e) { /* corrupt — ignore */ }
      // An explicit panel selection or chosen default already drove loadSettings.
      if (saved.provider || saved.defaultProvider) return;

      let candidate = null;
      try {
        const res = await window.electronAPI?.ai?.getDefaultProvider?.();
        candidate = res?.provider || null;
      } catch (e) { /* main unavailable — fall through */ }

      if (!candidate) {
        const checks = await Promise.all(PROVIDER_IDS.map((id) => hasApiKeyForProvider(id)));
        candidate = PROVIDER_IDS.find((_, i) => checks[i]) || null;
      }

      if (candidate) {
        setSelectedProvider(candidate);
        form.setFieldValue('provider', candidate);
      }
    } catch (e) {
      console.warn('[ProviderSettings] could not resolve configured provider:', e);
    }
  };

  // Check API key for selected provider when it changes
  useEffect(() => {
    checkProviderApiKey(selectedProvider);
  }, [selectedProvider]);

  // (Re)load the model list whenever the DEFAULT provider changes — that's the
  // provider the model belongs to. For OpenAI-compatible providers the current
  // model lives in their encrypted entry, so seed the field from there first;
  // loadModels then only supplies suggestions.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (defaultProvider && COMPAT_IDS.includes(defaultProvider)) {
        let stored;
        try {
          const res = await window.electronAPI?.ai?.getCompatProvider?.(defaultProvider);
          stored = res?.meta?.model || undefined;
        } catch (e) {
          console.warn('[ProviderSettings] could not read compat provider config:', e);
        }
        if (cancelled) return;
        // Always assign: an empty stored model must clear whatever the previous
        // provider left in the field.
        form.setFieldValue('model', stored);
      }
      if (!cancelled) loadModels(defaultProvider);
    })();
    return () => { cancelled = true; };
  }, [defaultProvider]);

  // Keep the form field and its state copy in lockstep: the model list and the
  // Max Tokens cap are derived from the default provider.
  const applyDefaultProvider = (id) => {
    form.setFieldValue('defaultProvider', id || undefined);
    setDefaultProviderValue(id || null);
  };

  const loadSettings = () => {
    try {
      const savedSettings = localStorage.getItem('ai-provider-settings');
      if (savedSettings) {
        const settings = JSON.parse(savedSettings);
        // Open on the configured provider, not a hardcoded one: prefer the last
        // panel selection, then the chosen default provider. initSelectedProvider
        // (mount) resolves the main-process default / first keyed provider when
        // localStorage has neither, so a Claude fallback only happens when
        // nothing else is configured.
        const initialProvider = settings.provider || settings.defaultProvider || 'claude';
        setSelectedProvider(initialProvider);
        form.setFieldsValue({
          provider: initialProvider,
          model: settings.model || undefined,
          maxTokens: settings.maxTokens || DEFAULT_MAX_TOKENS
        });
        applyDefaultProvider(settings.defaultProvider || settings.provider || null);
      } else {
        // Set default values. The model is left empty on purpose — loadModels
        // fills it from the default provider's live list.
        form.setFieldsValue({
          provider: 'claude',
          maxTokens: DEFAULT_MAX_TOKENS
        });
      }
    } catch (error) {
      console.error('Error loading provider settings:', error);
    }
  };

  const checkApiKey = async () => {
    try {
      // Check if ANY API key is configured (safe - doesn't expose key value)
      const { hasAnyApiKey } = await import('../../utils/apiKeyStorage');
      const keyExists = await hasAnyApiKey();
      setHasApiKey(keyExists);
    } catch (error) {
      console.error('Error checking API key:', error);
      setHasApiKey(false);
    }
  };

  const refreshConfiguredProviders = async () => {
    try {
      const checks = await Promise.all(PROVIDER_IDS.map((id) => hasApiKeyForProvider(id)));
      const configured = PROVIDER_IDS.filter((_, i) => checks[i]);
      setConfiguredProviders(configured);
      // If no default has been chosen yet, preselect the first configured provider
      if (configured.length > 0 && !form.getFieldValue('defaultProvider')) {
        applyDefaultProvider(configured[0]);
      }
    } catch (error) {
      console.error('Error checking configured providers:', error);
    }
  };

  const checkProviderApiKey = async (provider) => {
    try {

      const keyExists = await hasApiKeyForProvider(provider);
      console.log('keyExists: ', keyExists, provider)
      setProviderHasKey(keyExists);
    } catch (error) {
      console.error('Error checking provider API key:', error);
      setProviderHasKey(false);
    }
  };

  // Populate the model dropdown for the default `provider`. Fetches the live
  // list via the SDK; falls back to the bundled curated list when that isn't
  // possible (outside Electron, or the call fails). Reconciles the form's
  // selected model so it stays valid for whatever list we end up with — this is
  // what stops a Claude model id from surviving a switch to OpenAI.
  const loadModels = async (provider) => {
    // 'others' is the picker for the compat group, not a provider itself.
    if (!provider || provider === 'others') {
      setModels([]);
      return;
    }

    const isCompat = COMPAT_IDS.includes(provider);
    const bundled = enrichModels(provider, PROVIDER_MODELS[provider] || []);

    const apply = (list) => {
      setModels(list);
      const current = form.getFieldValue('model');
      if (isCompat) {
        // A compat endpoint may serve model ids it doesn't enumerate (and local
        // servers list none at all), so a stored id is never overruled — the
        // list is only a suggestion source, and only fills an empty field.
        if (!current && list.length > 0) form.setFieldValue('model', list[0].value);
        return;
      }
      if (list.length > 0 && !list.some((m) => m.value === current)) {
        form.setFieldValue('model', list[0].value);
      }
    };

    if (!window.electronAPI?.ai?.listModels) {
      apply(bundled);
      return;
    }

    setModelsLoading(true);
    try {
      const res = await window.electronAPI.ai.listModels(provider);
      if (res?.success && Array.isArray(res.models) && res.models.length > 0) {
        apply(enrichModels(provider, res.models));
      } else {
        apply(bundled);
      }
    } catch (error) {
      console.warn('[ProviderSettings] listModels failed; using bundled list:', error);
      apply(bundled);
    } finally {
      setModelsLoading(false);
    }
  };

  // Switching the panel below only changes which provider's API key you're
  // managing — it doesn't touch the model, which follows the default provider.
  const handleProviderChange = (provider) => {
    setSelectedProvider(provider);
    setChangingKey(false);
  };

  const handleKeySetupComplete = async () => {
    // After key is saved, refresh checks
    await checkApiKey();
    await checkProviderApiKey(selectedProvider);
    await refreshConfiguredProviders();
    message.success('API key configured successfully!');
  };

  const handleKeyChanged = async () => {
    await checkApiKey();
    await checkProviderApiKey(selectedProvider);
    await refreshConfiguredProviders();
    setChangingKey(false);
    message.success('API key updated successfully!');
  };

  // Merge a partial settings object into localStorage's ai-provider-settings.
  const mergeSettings = (patch) => {
    let current = {};
    try {
      current = JSON.parse(localStorage.getItem('ai-provider-settings') || '{}');
    } catch (e) { /* corrupt settings — overwrite */ }
    const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
    localStorage.setItem('ai-provider-settings', JSON.stringify(next));
    return next;
  };

  // Persist the default provider to the main process too, so backend-internal
  // AI calls (chat, titles, workflow builds) honor it — not just renderer calls.
  const persistDefaultProvider = async (provider, model) => {
    // Surface failures instead of swallowing them — a silent failure here is
    // why the assistant/workflow-builder can ignore the saved provider.
    const res = await window.electronAPI?.ai?.setDefaultProvider?.(provider, model);
    if (res && res.success === false) {
      throw new Error(res.error || 'Failed to persist default provider');
    }
  };

  // Reconcile renderer (localStorage) and main-process copies of the default
  // provider on mount — covers upgrades where one side was set before the other
  // existed. localStorage wins if both differ (it's the UI source of truth).
  const reconcileDefaultProvider = async () => {
    try {
      let local = null;
      let localModel;
      try {
        const saved = JSON.parse(localStorage.getItem('ai-provider-settings') || '{}');
        local = saved.defaultProvider || null;
        // Only carry the model across when it was chosen for THIS provider.
        if (local && saved.provider === local && saved.model) localModel = saved.model;
      } catch (e) { /* corrupt — ignore */ }
      const res = await window.electronAPI?.ai?.getDefaultProvider?.();
      const main = res?.provider || null;
      if (local && local !== main) {
        await persistDefaultProvider(local, localModel);
      } else if (main && !local) {
        mergeSettings({ defaultProvider: main });
        applyDefaultProvider(main);
      }
    } catch (e) {
      console.warn('[ProviderSettings] default provider reconcile failed:', e);
    }
  };

  // An OpenAI-compatible ("Others") provider was configured. Refresh the
  // configured list and make it the default if no default is set yet.
  const handleOthersComplete = async ({ provider } = {}) => {
    await checkApiKey();
    await refreshConfiguredProviders();
    if (provider && !form.getFieldValue('defaultProvider')) {
      applyDefaultProvider(provider);
      mergeSettings({ defaultProvider: provider });
      // Compat providers carry their model in the encrypted key entry, so we
      // don't pass a model here (main resolves it downstream).
      try {
        await persistDefaultProvider(provider);
      } catch (e) {
        console.error('[ProviderSettings] Could not persist compat default to main:', e);
      }
    }
    message.success('Provider configured successfully!');
  };

  // Save the default provider together with the model and Max Tokens that
  // belong to it — one section, one button. The provider/model pair is written
  // as a unit everywhere it's stored so a model can never outlive the provider
  // it was chosen for.
  const handleSaveDefault = async () => {
    try {
      setSavingDefault(true);
      const values = form.getFieldsValue();
      const provider = values.defaultProvider;
      if (!provider) {
        message.warning('Select a default provider first.');
        return;
      }

      const isCompat = COMPAT_IDS.includes(provider);
      const model = (values.model || '').trim() || undefined;
      if (!model) {
        message.warning('Select a model for this provider.');
        return;
      }

      // A compat provider's model lives in its encrypted entry — that's what
      // the main process reads when a call doesn't name one. Writing only the
      // model preserves the stored key and base URL.
      if (isCompat) {
        const res = await window.electronAPI?.ai?.saveCompatProvider?.(provider, { model });
        if (res && res.success === false) {
          throw new Error(res.error || 'Failed to save the model for this provider');
        }
      }

      // `provider` mirrors `defaultProvider` so every reader that pairs the two
      // with `model` (renderer callAI) stays consistent.
      mergeSettings({
        defaultProvider: provider,
        provider,
        model,
        temperature: 0.7,
      });
      // Writes localStorage AND the main-process prefs, clamped to what the
      // chosen model accepts, so backend calls honor the same number.
      const cap = models.find((m) => m.value === model)?.maxOutputTokens || null;
      await saveMaxTokens(values.maxTokens || DEFAULT_MAX_TOKENS, cap);
      await persistDefaultProvider(provider, model);
      message.success('Default AI provider saved!');
    } catch (error) {
      console.error('Error saving default provider:', error);
      message.error(error.message || 'Failed to save default provider');
    } finally {
      setSavingDefault(false);
    }
  };

  const currentProviderInfo = PROVIDER_INFO[selectedProvider];
  const isCompatDefault = !!defaultProvider && COMPAT_IDS.includes(defaultProvider);


  return (
    <div style={{ maxWidth: 800, margin: '0 auto' }}>
      <Space direction="vertical" size="large" style={{ width: '100%' }}>
        {/* Header */}
        <div>
          <Title level={3}>
            <RobotOutlined style={{ marginRight: 12, color: '#1890ff' }} />
            AI Provider Configuration
          </Title>
          <Paragraph type="secondary">
            Configure which AI provider and model to use for workflow assistance and data transformations.
          </Paragraph>
        </div>



        {/* Provider Selection Card */}
        <Card>
          <Form
            form={form}
            layout="vertical"
          >
            {/* Default provider — provider + its model + its Max Tokens, saved
                together by one button. This is what every AI feature uses; the
                "Configure Provider" section below only manages API keys. */}
            {configuredProviders.length > 0 && (
              <Card
                size="small"
                type="inner"
                title="Default AI Provider"
                style={{ marginBottom: 24, background: '#fafafa' }}
              >
                <Form.Item
                  name="defaultProvider"
                  help={
                    configuredProviders.length > 1
                      ? 'You have multiple providers configured. AI features (chat, workflow build, transforms) will use this one.'
                      : 'AI features will use this provider. Configure more providers below to switch between them.'
                  }
                  style={{ marginBottom: 16 }}
                >
                  <Select
                    size="large"
                    placeholder="Select default provider"
                    getPopupContainer={(trigger) => trigger.parentNode}
                    onChange={applyDefaultProvider}
                  >
                    {configuredProviders.map((id) => (
                      <Option key={id} value={id}>
                        <Space>
                          <span style={{ color: getProviderInfo(id).color, fontWeight: 600 }}>●</span>
                          {getProviderInfo(id).name}
                        </Space>
                      </Option>
                    ))}
                  </Select>
                </Form.Item>

                {/* Model for the default provider. The list is refetched from
                    that provider whenever it changes, and a model that isn't in
                    the new list is replaced — a Claude model can't survive a
                    switch to OpenAI. OpenAI-compatible endpoints get a free-text
                    field with their /models list as suggestions: they accept ids
                    they don't always enumerate, and local servers list none. */}
                {isCompatDefault ? (
                  <Form.Item
                    label="Model"
                    name="model"
                    rules={[{ required: true, message: 'Enter the model id to use' }]}
                    help={`The exact model id ${getProviderInfo(defaultProvider).name} expects. Suggestions are its published models — you can type any id it accepts.`}
                    style={{ marginBottom: 16 }}
                  >
                    <AutoComplete
                      size="large"
                      placeholder={OPENAI_COMPAT_PROVIDERS[defaultProvider]?.placeholderModel || 'model-id'}
                      options={models.map((m) => ({ value: m.value }))}
                      filterOption={(input, option) =>
                        String(option?.value || '').toLowerCase().includes(String(input || '').toLowerCase())
                      }
                      getPopupContainer={(trigger) => trigger.parentNode}
                      notFoundContent={modelsLoading ? 'Loading models…' : null}
                    />
                  </Form.Item>
                ) : defaultProvider ? (
                  <Form.Item
                    label="Model"
                    name="model"
                    rules={[{ required: true, message: 'Please select a model' }]}
                    style={{ marginBottom: 16 }}
                  >
                    <Select
                      size="large"
                      placeholder="Select model"
                      getPopupContainer={(trigger) => trigger.parentNode}
                      optionLabelProp="label"
                      loading={modelsLoading}
                      notFoundContent={modelsLoading ? 'Loading models…' : 'No models found'}
                    >
                      {models.map((model) => (
                        <Option
                          key={model.value}
                          value={model.value}
                          label={
                            <>
                              {model.label}
                              {model.description.includes('Recommended') && (
                                <CheckCircleOutlined
                                  style={{ marginLeft: 8, color: '#52c41a' }}
                                />
                              )}
                            </>
                          }
                        >
                          <div>
                            <div style={{ fontWeight: 500 }}>
                              {model.label}
                              {model.description.includes('Recommended') && (
                                <CheckCircleOutlined
                                  style={{ marginLeft: 8, color: '#52c41a' }}
                                />
                              )}
                            </div>
                            <div style={{ fontSize: 12, color: '#8c8c8c' }}>
                              {model.description}
                            </div>
                          </div>
                        </Option>
                      ))}
                    </Select>
                  </Form.Item>
                ) : null}

                <Divider style={{ marginTop: 8 }} />

                {/* Advanced Settings */}
                <Title level={5}>Advanced Settings</Title>
                <Paragraph type="secondary" style={{ fontSize: 13 }}>
                  Configure maximum response length for AI outputs.
                </Paragraph>

                {/* Bounded by the selected model's published output limit, read
                    from the same provider models endpoint that fills the model
                    dropdown. Providers that don't publish limits get the full
                    ladder. */}
                <Form.Item noStyle shouldUpdate={(prev, cur) => prev.model !== cur.model}>
                  {({ getFieldValue }) => {
                    const selected = models.find((m) => m.value === getFieldValue('model'));
                    const cap = selected?.maxOutputTokens || null;
                    const ctx = selected?.maxInputTokens || null;
                    return (
                      <Form.Item
                        label="Max Tokens"
                        name="maxTokens"
                        help={
                          cap
                            ? `Maximum length of AI responses. ${selected.label} accepts up to ${cap.toLocaleString()} output tokens${ctx ? ` and a ${ctx.toLocaleString()}-token context window` : ''}. Reasoning models spend part of this budget thinking before they answer, so low values can cut a reply short.`
                            : 'Maximum length of AI responses. This provider does not publish per-model limits, so an unsupported value is rejected at request time. Reasoning models spend part of this budget thinking before they answer, so low values can cut a reply short.'
                        }
                        style={{ marginBottom: 20 }}
                      >
                        <Select getPopupContainer={(trigger) => trigger.parentNode}>
                          {buildTokenOptions(cap).map((o) => (
                            <Option key={o.value} value={o.value}>{o.label}</Option>
                          ))}
                        </Select>
                      </Form.Item>
                    );
                  }}
                </Form.Item>

                <Button
                  type="primary"
                  icon={<SaveOutlined />}
                  loading={savingDefault}
                  onClick={handleSaveDefault}
                >
                  Save Default Provider
                </Button>
              </Card>
            )}

            {/* Provider Selection — API keys only. The model and Max Tokens
                live with the default provider above. */}
            <Form.Item
              label="Configure Provider"
              name="provider"
              help="Add or replace the API key for a provider. Which provider the app actually uses — and with which model — is set above."
              rules={[{ required: true, message: 'Please select a provider' }]}
            >
              <Select
                size="large"
                onChange={handleProviderChange}
                placeholder="Select AI provider"
                getPopupContainer={(trigger) => trigger.parentNode}
              >
                <Option value="gemini">
                  <Space>
                    <span style={{ color: PROVIDER_INFO.gemini.color, fontWeight: 600 }}>●</span>
                    Google Gemini
                  </Space>
                </Option>
                <Option value="claude">
                  <Space>
                    <span style={{ color: PROVIDER_INFO.claude.color, fontWeight: 600 }}>●</span>
                    Anthropic Claude
                  </Space>
                </Option>
                <Option value="openai">
                  <Space>
                    <span style={{ color: PROVIDER_INFO.openai.color, fontWeight: 600 }}>●</span>
                    OpenAI ChatGPT
                  </Space>
                </Option>
                <Option value="others">
                  <Space>
                    <span style={{ color: '#8c8c8c', fontWeight: 600 }}>●</span>
                    Others (OpenAI-compatible)
                  </Space>
                </Option>
              </Select>
            </Form.Item>

            {// "Others" = OpenAI-compatible providers (own dropdown + URL/key/model form).
             // Otherwise: no key → show the key form; key present → offer to replace it.
            }
  {selectedProvider === 'others' ? (
    <div>
      <Card
        size="small"
        style={{ marginBottom: 24, borderLeft: '4px solid #8c8c8c', background: '#fafafa' }}
      >
        <Text strong>Others (OpenAI-compatible)</Text>
        <br />
        <Text type="secondary" style={{ fontSize: 13 }}>
          Connect OpenRouter, Groq, Together AI, Mistral, Ollama, LM Studio, or any
          OpenAI-compatible endpoint. Pick a type to prefill its URL, or choose Custom to set your own.
        </Text>
      </Card>
      <OthersProviderForm onComplete={handleOthersComplete} />
    </div>
  ) : (!providerHasKey) ?

      <div style={{ maxWidth: 800, margin: '0 auto' }}>
        <Space direction="vertical" size="large" style={{ width: '100%' }}>
          {/* Header */}
          <div>
            <Title level={3}>
              <RobotOutlined style={{ marginRight: 12, color: '#1890ff' }} />
              Configure {PROVIDER_INFO[selectedProvider]?.name || selectedProvider}
            </Title>
            <Paragraph type="secondary">
              Set up your API key for {PROVIDER_INFO[selectedProvider]?.name || selectedProvider} to use this provider.
            </Paragraph>
          </div>

          {/* Alert explaining the situation */}
          <Alert
            message={`No API Key for ${PROVIDER_INFO[selectedProvider]?.name || selectedProvider}`}
            description={`You need to configure an API key for ${PROVIDER_INFO[selectedProvider]?.name || selectedProvider} before you can select models and configure settings for this provider.`}
            type="info"
            showIcon
          />

          {/* Provider Key Form - embedded */}
          <div style={{ marginTop: 16 }}>
            <ProviderKeyForm
              providerId={selectedProvider}
              onComplete={handleKeySetupComplete}
              compact={true}
            />
          </div>
        </Space>
      </div> :
  
            <div>
            {/* Provider Info */}
            {currentProviderInfo && (
              <Card
                size="small"
                style={{
                  marginBottom: 24,
                  borderLeft: `4px solid ${currentProviderInfo.color}`,
                  background: '#fafafa'
                }}
              >
                <Text strong>{currentProviderInfo.name}</Text>
                <br />
                <Text type="secondary" style={{ fontSize: 13 }}>
                  {currentProviderInfo.description}
                </Text>
              </Card>
            )}

            {/* API key management — the key exists; allow replacing it */}
            {!changingKey ? (
              <Alert
                type="success"
                showIcon
                icon={<CheckCircleOutlined />}
                message={`API key configured for ${currentProviderInfo?.name || selectedProvider}`}
                description="The key is encrypted and stored on this device."
                action={
                  <Button
                    size="small"
                    icon={<EditOutlined />}
                    onClick={() => setChangingKey(true)}
                  >
                    Change Key
                  </Button>
                }
                style={{ marginBottom: 24 }}
              />
            ) : (
              <Card
                size="small"
                title={`Change ${currentProviderInfo?.name || selectedProvider} API key`}
                extra={
                  <Button size="small" type="text" onClick={() => setChangingKey(false)}>
                    Cancel
                  </Button>
                }
                style={{ marginBottom: 24 }}
              >
                <Alert
                  type="warning"
                  showIcon
                  message="Saving a new key replaces the current one immediately."
                  style={{ marginBottom: 16 }}
                />
                <ProviderKeyForm
                  providerId={selectedProvider}
                  onComplete={handleKeyChanged}
                  compact={true}
                />
              </Card>
            )}

            {/* Nothing else to configure here: the model and Max Tokens for
                the provider the app uses live in "Default AI Provider" above. */}
            {defaultProvider !== selectedProvider && (
              <Text type="secondary" style={{ fontSize: 13 }}>
                To use {currentProviderInfo?.name || selectedProvider} for AI features,
                select it as the default provider above and pick its model.
              </Text>
            )}
            </div>}
          </Form>
        </Card>

        {/* Info Card */}
        <Card size="small" style={{ background: '#f0f5ff', borderColor: '#adc6ff' }}>
          <Text strong style={{ color: '#1890ff' }}>
            💡 How it works
          </Text>
          <br />
          <Text type="secondary" style={{ fontSize: 13 }}>
            The default provider and its model are used for all AI-powered features including:
            <ul style={{ marginTop: 8, marginBottom: 0 }}>
              <li>Workflow node configuration assistance</li>
              <li>SQL query generation from natural language</li>
              <li>Data transformation suggestions</li>
              <li>Business intelligence chat responses</li>
            </ul>
          </Text>
        </Card>
      </Space>
    </div>
  );
};

export default ProviderSettings;
