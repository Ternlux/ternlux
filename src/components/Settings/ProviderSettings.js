import React, { useState, useEffect } from 'react';
import { Form, Select, Card, Button, message, Divider, Typography, Space, Alert } from 'antd';
import { RobotOutlined, CheckCircleOutlined, SaveOutlined, EditOutlined } from '@ant-design/icons';
import ProviderKeyForm from '../ApiKeySetup/ProviderKeyForm';
import OthersProviderForm from '../ApiKeySetup/OthersProviderForm';
import { hasApiKeyForProvider } from '../../utils/apiKeyStorage';
import { OPENAI_COMPAT_PROVIDERS } from '../../utils/aiProviders';
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
    };
  });
};

const ProviderSettings = () => {
  const [form] = Form.useForm();
  const [selectedProvider, setSelectedProvider] = useState('claude');
  const [loading, setLoading] = useState(false);
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
    checkApiKey();
    refreshConfiguredProviders();
    reconcileDefaultProvider();
  }, []);

  // Check API key for selected provider when it changes
  useEffect(() => {
    checkProviderApiKey(selectedProvider);
  }, [selectedProvider]);

  // (Re)load the model list whenever the provider — or whether it has a key —
  // changes. With a key we fetch the live SDK list; without one we show the
  // bundled list so the dropdown is never empty.
  useEffect(() => {
    loadModels(selectedProvider, providerHasKey);
  }, [selectedProvider, providerHasKey]);

  const loadSettings = () => {
    try {
      const savedSettings = localStorage.getItem('ai-provider-settings');
      if (savedSettings) {
        const settings = JSON.parse(savedSettings);
        setSelectedProvider(settings.provider || 'claude');
        form.setFieldsValue({
          defaultProvider: settings.defaultProvider || settings.provider || undefined,
          provider: settings.provider || 'claude',
          model: settings.model || 'claude-3-5-sonnet-20241022',
          maxTokens: settings.maxTokens || 2048
        });
      } else {
        // Set default values
        form.setFieldsValue({
          provider: 'claude',
          model: 'claude-3-5-sonnet-20241022',
          maxTokens: 2048
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
        form.setFieldValue('defaultProvider', configured[0]);
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

  // Populate the model dropdown for `provider`. Fetches the live list via the
  // SDK when a key is configured; otherwise (no key, or running outside
  // Electron) falls back to the bundled curated list. Reconciles the form's
  // selected model so it stays valid for whatever list we end up with.
  const loadModels = async (provider, hasKey) => {
    // "Others" (OpenAI-compatible) providers manage their own model field.
    if (provider === 'others') {
      setModels([]);
      return;
    }

    const bundled = enrichModels(provider, PROVIDER_MODELS[provider] || []);

    const apply = (list) => {
      setModels(list);
      const current = form.getFieldValue('model');
      if (list.length > 0 && !list.some((m) => m.value === current)) {
        form.setFieldValue('model', list[0].value);
      }
    };

    if (!hasKey || !window.electronAPI?.ai?.listModels) {
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

  const handleProviderChange = (provider) => {
    setSelectedProvider(provider);
    setChangingKey(false);
    // "Others" (OpenAI-compatible) providers manage their own model field in
    // OthersProviderForm — there's no predefined model list to seed here.
    if (provider === 'others' || !PROVIDER_MODELS[provider]) return;
    const defaultModel = PROVIDER_MODELS[provider][0].value;
    form.setFieldValue('model', defaultModel);
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
  const persistDefaultProvider = async (provider) => {
    try {
      await window.electronAPI?.ai?.setDefaultProvider?.(provider);
    } catch (e) {
      console.warn('[ProviderSettings] Could not persist default provider to main:', e);
    }
  };

  // Reconcile renderer (localStorage) and main-process copies of the default
  // provider on mount — covers upgrades where one side was set before the other
  // existed. localStorage wins if both differ (it's the UI source of truth).
  const reconcileDefaultProvider = async () => {
    try {
      let local = null;
      try {
        local = JSON.parse(localStorage.getItem('ai-provider-settings') || '{}').defaultProvider || null;
      } catch (e) { /* corrupt — ignore */ }
      const res = await window.electronAPI?.ai?.getDefaultProvider?.();
      const main = res?.provider || null;
      if (local && local !== main) {
        await persistDefaultProvider(local);
      } else if (main && !local) {
        mergeSettings({ defaultProvider: main });
        form.setFieldValue('defaultProvider', main);
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
      form.setFieldValue('defaultProvider', provider);
      mergeSettings({ defaultProvider: provider });
      await persistDefaultProvider(provider);
    }
    message.success('Provider configured successfully!');
  };

  // Save ONLY the default provider (its own section/button).
  const handleSaveDefault = async () => {
    try {
      setSavingDefault(true);
      const defaultProvider = form.getFieldValue('defaultProvider');
      if (!defaultProvider) {
        message.warning('Select a default provider first.');
        return;
      }
      mergeSettings({ defaultProvider });
      await persistDefaultProvider(defaultProvider);
      message.success('Default AI provider saved!');
    } catch (error) {
      console.error('Error saving default provider:', error);
      message.error('Failed to save default provider');
    } finally {
      setSavingDefault(false);
    }
  };

  // Save the per-provider configuration (provider + model + max tokens). The
  // default provider is managed by its own section above.
  const handleSave = async () => {
    try {
      setLoading(true);
      const values = await form.validateFields();
      mergeSettings({
        provider: values.provider,
        model: values.model,
        temperature: 0.7,
        maxTokens: values.maxTokens || 2048,
      });
      message.success('Provider settings saved successfully!');
    } catch (error) {
      console.error('Error saving provider settings:', error);
      message.error('Failed to save provider settings');
    } finally {
      setLoading(false);
    }
  };

  const currentProviderInfo = PROVIDER_INFO[selectedProvider];


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
            {/* Default provider — its own section + save button. This is the
                provider every AI feature uses; it's independent of which
                provider you're currently configuring below. */}
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

            {/* Provider Selection */}
            <Form.Item
              label="Configure Provider"
              name="provider"
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
             // Otherwise: no key → show the key form; key present → show model/settings.
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

            {/* Model Selection */}
            <Form.Item
              label="Model"
              name="model"
              rules={[{ required: true, message: 'Please select a model' }]}
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

            <Divider />

            {/* Advanced Settings */}
            <Title level={5}>Advanced Settings</Title>
            <Paragraph type="secondary" style={{ fontSize: 13 }}>
              Configure maximum response length for AI outputs.
            </Paragraph>

            <Form.Item
              label="Max Tokens"
              name="maxTokens"
              help="Maximum length of AI responses. Higher values allow longer responses."
            >
              <Select getPopupContainer={(trigger) => trigger.parentNode}>
                <Option value={1024}>1024 - Short responses</Option>
                <Option value={2048}>2048 - Standard (Recommended)</Option>
                <Option value={4096}>4096 - Long responses</Option>
                <Option value={8192}>8192 - Very long responses</Option>
              </Select>
            </Form.Item>

            {/* Save Button */}
            <Form.Item style={{ marginTop: 32, marginBottom: 0 }}>
              <Button
                type="primary"
                size="large"
                icon={<SaveOutlined />}
                loading={loading}
                onClick={handleSave}
                block
              >
                Save Provider Settings
              </Button>

            </Form.Item>
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
            The selected provider and model will be used for all AI-powered features including:
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
