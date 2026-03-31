import React, { useState, useEffect } from 'react';
import { Form, Select, Card, Button, message, Divider, Typography, Space, Alert } from 'antd';
import { RobotOutlined, CheckCircleOutlined, SaveOutlined } from '@ant-design/icons';
import ProviderKeyForm from '../ApiKeySetup/ProviderKeyForm';
import { hasApiKeyForProvider } from '../../utils/apiKeyStorage';
import AI_CONFIG from '../../config/aiProviders.json';

const { Option } = Select;
const { Title, Text, Paragraph } = Typography;

// Import from JSON config
const PROVIDER_MODELS = AI_CONFIG.PROVIDER_MODELS;
const PROVIDER_INFO = AI_CONFIG.PROVIDER_INFO;

const ProviderSettings = () => {
  const [form] = Form.useForm();
  const [selectedProvider, setSelectedProvider] = useState('claude');
  const [loading, setLoading] = useState(false);
  const [hasApiKey, setHasApiKey] = useState(false);
  const [providerHasKey, setProviderHasKey] = useState(true); // Track if selected provider has key

  // Load saved settings on mount
  useEffect(() => {
    loadSettings();
    checkApiKey();
  }, []);

  // Check API key for selected provider when it changes
  useEffect(() => {
    checkProviderApiKey(selectedProvider);
  }, [selectedProvider]);

  const loadSettings = () => {
    try {
      const savedSettings = localStorage.getItem('ai-provider-settings');
      if (savedSettings) {
        const settings = JSON.parse(savedSettings);
        setSelectedProvider(settings.provider || 'claude');
        form.setFieldsValue({
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

  const handleProviderChange = (provider) => {
    setSelectedProvider(provider);
    // Set default model for the selected provider
    const defaultModel = PROVIDER_MODELS[provider][0].value;
    form.setFieldValue('model', defaultModel);
  };

  const handleKeySetupComplete = async () => {
    // After key is saved, refresh checks
    await checkApiKey();
    await checkProviderApiKey(selectedProvider);
    message.success('API key configured successfully!');
  };

  const handleSave = async () => {
    try {
      setLoading(true);
      const values = await form.validateFields();

      // Save to localStorage
      const settings = {
        provider: values.provider,
        model: values.model,
        temperature: 0.7, // Default temperature
        maxTokens: values.maxTokens || 2048,
        updatedAt: new Date().toISOString()
      };

      localStorage.setItem('ai-provider-settings', JSON.stringify(settings));

      message.success('Provider settings saved successfully!');
    } catch (error) {
      console.error('Error saving provider settings:', error);
      message.error('Failed to save provider settings');
    } finally {
      setLoading(false);
    }
  };

  const currentProviderInfo = PROVIDER_INFO[selectedProvider];
  const currentModels = PROVIDER_MODELS[selectedProvider];


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
            onFinish={handleSave}
          >
            {/* Provider Selection */}
            <Form.Item
              label="AI Provider"
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
              </Select>
            </Form.Item>

            {// If the selected provider doesn't have a key, show the key form
            }
  {(!providerHasKey) ?
    
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
              >
                {currentModels.map((model) => (
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
