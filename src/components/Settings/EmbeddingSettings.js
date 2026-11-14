import React, { useEffect, useState } from 'react';
import { Collapse, Form, Select, Button, Alert, Typography, Space, message } from 'antd';
import { SaveOutlined, CheckCircleOutlined, ReloadOutlined } from '@ant-design/icons';

const { Option } = Select;
const { Text, Paragraph } = Typography;

/**
 * Settings → AI Provider → Default Embedding Model.
 *
 * The ONE embedding model every new embedding step uses (Transformer embed,
 * Join into a vector store, Output to a vector destination, ctx.vectorize) —
 * the AI never picks one. Providers and models are discovered, not hardcoded:
 * the main process asks each configured provider for its models and keeps
 * only the ones its own metadata marks as embedding models. Saving embeds one
 * probe string first and is refused if no vector comes back, so whatever is
 * saved is guaranteed to be a vector model; that probe also measures the
 * model's dimensions.
 *
 * `refreshKey` changes whenever the set of configured providers changes, so a
 * newly added key shows up without a reload.
 */
const EmbeddingSettings = ({ refreshKey }) => {
  const [form] = Form.useForm();
  const [providers, setProviders] = useState([]);
  const [provider, setProvider] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saved, setSaved] = useState({ provider: null, model: null, dimensions: null });
  const [saving, setSaving] = useState(false);
  const [reloadTick, setReloadTick] = useState(0);

  const api = window.electronAPI?.ai;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!api?.listEmbeddingProviders) return;
      setLoading(true);
      try {
        const [pRes, dRes] = await Promise.all([api.listEmbeddingProviders(), api.getEmbeddingDefault?.()]);
        if (cancelled) return;
        const list = pRes?.providers || [];
        const def = { provider: dRes?.provider || null, model: dRes?.model || null, dimensions: dRes?.dimensions || null };
        setProviders(list);
        setSaved(def);
        const start = list.find((p) => p.id === def.provider) || list[0] || null;
        const model = start && start.id === def.provider && start.models.some((m) => m.value === def.model)
          ? def.model
          : start?.models[0]?.value;
        form.setFieldsValue({ provider: start?.id, model });
        setProvider(start?.id || null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [api, form, refreshKey, reloadTick]);

  const modelsOf = (id) => providers.find((p) => p.id === id)?.models || [];
  const labelOf = (id) => providers.find((p) => p.id === id)?.label || id;

  const handleSave = async () => {
    const { provider: p, model } = form.getFieldsValue();
    if (!p || !model) {
      message.warning('Pick an embedding provider and model.');
      return;
    }
    setSaving(true);
    try {
      const res = await api.setEmbeddingDefault(p, model);
      if (!res?.success) throw new Error(res?.error || 'Could not save the embedding model');
      setSaved({ provider: res.provider, model: res.model, dimensions: res.dimensions });
      message.success(`Embedding model saved (${res.dimensions} dimensions).`);
    } catch (e) {
      message.error(e.message);
    } finally {
      setSaving(false);
    }
  };

  if (!api?.listEmbeddingProviders) return null;

  const body = (
    <>
      <Paragraph type="secondary" style={{ fontSize: 13 }}>
        Turns text into vectors in every Transformer, Join and Output step that writes to or
        searches a vector database. A step keeps the model it was built with, so changing this
        only affects steps you build afterwards.
      </Paragraph>

      {!loading && providers.length === 0 ? (
        <Alert
          type="info"
          showIcon
          message="No embedding models found"
          description="None of your configured providers lists an embedding model. Add a provider that has one (for example OpenAI, Google Gemini, Mistral, Together AI, or an Ollama / LM Studio server that is running with an embedding model loaded) on the API Keys tab."
          action={<Button size="small" icon={<ReloadOutlined />} onClick={() => setReloadTick((t) => t + 1)}>Retry</Button>}
        />
      ) : (
        <Form form={form} layout="vertical">
          <Form.Item label="Embedding provider" name="provider" style={{ marginBottom: 16 }}>
            <Select
              size="large"
              loading={loading}
              onChange={(v) => { setProvider(v); form.setFieldValue('model', modelsOf(v)[0]?.value); }}
              getPopupContainer={(trigger) => trigger.parentNode}
            >
              {providers.map((p) => (
                <Option key={p.id} value={p.id}>{p.label}</Option>
              ))}
            </Select>
          </Form.Item>

          <Form.Item
            label="Embedding model"
            name="model"
            style={{ marginBottom: 16 }}
            help="Only models the provider marks as embedding models are listed. The model is checked by embedding a test string before it is saved."
          >
            <Select
              size="large"
              loading={loading}
              placeholder="Select embedding model"
              notFoundContent="No embedding models found"
              getPopupContainer={(trigger) => trigger.parentNode}
            >
              {modelsOf(provider).map((m) => (
                <Option key={m.value} value={m.value}>{m.label}</Option>
              ))}
            </Select>
          </Form.Item>

          <Space align="center" wrap>
            <Button type="primary" icon={<SaveOutlined />} loading={saving} onClick={handleSave}>
              Save Embedding Model
            </Button>
            <Button icon={<ReloadOutlined />} onClick={() => setReloadTick((t) => t + 1)} disabled={loading}>
              Refresh models
            </Button>
          </Space>
        </Form>
      )}

      {saved.provider && (
        <div style={{ marginTop: 12 }}>
          <Text type="secondary" style={{ fontSize: 13 }}>
            <CheckCircleOutlined style={{ color: '#52c41a', marginRight: 6 }} />
            Current: {labelOf(saved.provider)} / {saved.model}
            {saved.dimensions ? ` · ${saved.dimensions} dimensions` : ''}
          </Text>
        </div>
      )}
    </>
  );

  return (
    <Collapse
      defaultActiveKey={['embedding']}
      items={[{ key: 'embedding', label: 'Default Embedding Model', forceRender: true, children: body }]}
    />
  );
};

export default EmbeddingSettings;
