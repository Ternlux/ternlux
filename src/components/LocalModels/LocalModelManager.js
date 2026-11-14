import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert, Button, Card, Collapse, Input, List, Popconfirm, Progress, Space, Tag, Typography, message,
} from 'antd';
import {
  CheckCircleOutlined, CloudDownloadOutlined, DeleteOutlined, LoadingOutlined, ReloadOutlined, SearchOutlined,
} from '@ant-design/icons';

const { Text, Paragraph, Title } = Typography;

const ROLES = {
  chat: {
    title: 'Chat model',
    blurb: 'Answers questions, builds workflows and writes SQL. Runs on this computer — nothing is sent to a cloud service.',
  },
  embedding: {
    title: 'Embedding model',
    blurb: 'Turns text into vectors for vector databases and similarity search. Small and fast.',
  },
};

const FIT = {
  good: { color: 'green', text: 'Runs well here' },
  tight: { color: 'orange', text: 'Tight on memory' },
  too_large: { color: 'red', text: 'Too large for this computer' },
};

const gb = (bytes) => {
  if (!bytes) return '—';
  if (bytes < 1e9) return `${Math.max(1, Math.round(bytes / 1e6))} MB`;
  return `${(bytes / 1e9).toFixed(1)} GB`;
};
const keyOf = (m) => `${m.repo}/${m.file}`;

/**
 * Pick, download and use local models (run by Ternlux's bundled llama-server).
 *
 * Used in two places with the same behaviour: onboarding (mode "onboarding",
 * where choosing a chat model finishes setup) and Settings → AI Provider →
 * Local Models. Everything runs in the main process; this only renders state.
 *
 * Props:
 *   mode        'onboarding' | 'settings'
 *   onComplete  onboarding: called when the user continues, once a chat
 *               model is the default
 */
const LocalModelManager = ({ mode = 'settings', onComplete }) => {
  const api = window.electronAPI?.localModels;
  const [status, setStatus] = useState(null);
  const [lists, setLists] = useState({ chat: null, embedding: null });
  const [popular, setPopular] = useState({ chat: null, embedding: null });
  const [loadingPopular, setLoadingPopular] = useState({});
  const [progress, setProgress] = useState({}); // repo/file → { received, total, verifying }
  const [busy, setBusy] = useState({});         // installed id → true while "use" runs
  const [pasted, setPasted] = useState({ chat: '', embedding: '' });

  const refreshStatus = useCallback(async () => {
    if (!api) return null;
    const s = await api.status();
    setStatus(s);
    return s;
  }, [api]);

  useEffect(() => {
    if (!api) return undefined;
    refreshStatus();
    ['chat', 'embedding'].forEach((role) => {
      api.recommended(role).then((res) => setLists((l) => ({ ...l, [role]: res?.models || [] })));
    });
    const off = api.onProgress((p) => {
      setProgress((prev) => {
        const next = { ...prev };
        const k = `${p.repo}/${p.file}`;
        if (p.done || p.error) delete next[k];
        else next[k] = p;
        return next;
      });
    });
    return off;
  }, [api, refreshStatus]);

  const installedFor = (role) => (status?.installed || []).filter((m) => m.role === role);
  const inUse = (m) => (m.role === 'chat'
    ? status?.chatIsDefault && status?.chatModel === m.id
    : status?.embeddingModel === m.id);

  const use = async (installed, { silent = false } = {}) => {
    setBusy((b) => ({ ...b, [installed.id]: true }));
    try {
      const res = await api.use(installed.id);
      if (!res?.success) throw new Error(res?.error || 'Could not use this model');
      if (!silent) {
        message.success(installed.role === 'chat'
          ? `${installed.label} is now your AI model.`
          : `${installed.label} is now your embedding model (${res.dimensions} dimensions).`);
      }
      await refreshStatus();
      return true;
    } catch (e) {
      message.error(e.message);
      return false;
    } finally {
      setBusy((b) => ({ ...b, [installed.id]: false }));
    }
  };

  const download = async (m) => {
    if (m.fit?.rating === 'too_large') {
      message.warning('This model needs more memory than this computer has.');
      return;
    }
    setProgress((p) => ({ ...p, [keyOf(m)]: { received: 0, total: m.size } }));
    const res = await api.download({
      repo: m.repo, file: m.file, size: m.size, sha256: m.sha256, role: m.role, label: m.label,
    });
    setProgress((p) => { const n = { ...p }; delete n[keyOf(m)]; return n; });
    if (!res?.success) {
      if (!/cancelled/i.test(res?.error || '')) message.error(res?.error || 'Download failed');
      return;
    }
    const s = await refreshStatus();
    // The first model of a role is put to use straight away.
    const hasDefault = m.role === 'chat' ? s?.chatIsDefault && s?.chatModel : s?.embeddingModel;
    if (!hasDefault || mode === 'onboarding') await use(res.model);
    else message.success(`${m.label} downloaded.`);
  };

  const cancel = (m) => {
    // The main process names downloads by model id, which it derives from the
    // file; cancelling by every id that matches the file is enough.
    const id = m.file.split('/').pop().replace(/\.gguf$/i, '');
    api.cancel(id);
  };

  const remove = async (m) => {
    const res = await api.remove(m.id);
    if (!res?.success) message.error(res?.error || 'Could not delete');
    await refreshStatus();
  };

  const loadPopular = async (role, query = '') => {
    setLoadingPopular((l) => ({ ...l, [role]: true }));
    const res = await api.search(role, query);
    setPopular((p) => ({ ...p, [role]: res?.models || [] }));
    if (!res?.success) message.error(res?.error || 'Could not reach Hugging Face');
    setLoadingPopular((l) => ({ ...l, [role]: false }));
  };

  const addPasted = async (role) => {
    const repo = pasted[role].trim();
    if (!repo) return;
    const res = await api.resolveRepo(repo, role);
    if (!res?.success) { message.error(res.error); return; }
    setPopular((p) => ({ ...p, [role]: [res.model, ...(p[role] || []).filter((x) => x.repo !== res.model.repo)] }));
    setPasted((p) => ({ ...p, [role]: '' }));
  };

  const catalogRow = (m) => {
    const prog = progress[keyOf(m)];
    const installed = (status?.installed || []).find((i) => i.id === m.installedId);
    const fit = FIT[m.fit?.rating] || null;
    let action;
    if (installed) {
      action = inUse(installed)
        ? <Tag color="green" icon={<CheckCircleOutlined />}>In use</Tag>
        : <Button size="small" loading={busy[installed.id]} onClick={() => use(installed)}>Use</Button>;
    } else if (prog) {
      action = <Button size="small" onClick={() => cancel(m)}>Cancel</Button>;
    } else {
      action = (
        <Button
          size="small"
          type="primary"
          icon={<CloudDownloadOutlined />}
          disabled={m.fit?.rating === 'too_large'}
          onClick={() => download(m)}
        >
          Download {gb(m.size)}
        </Button>
      );
    }
    return (
      <List.Item key={keyOf(m)} actions={[action]}>
        <List.Item.Meta
          title={(
            <Space size={6} wrap>
              <Text strong>{m.label}</Text>
              {fit && <Tag color={fit.color}>{fit.text}</Tag>}
              {m.license && <Tag>{m.license}</Tag>}
            </Space>
          )}
          description={(
            <>
              {m.note && <div>{m.note}</div>}
              <Text type="secondary" style={{ fontSize: 12 }}>
                {m.repo} · {m.file.split('/').pop()} · needs about {gb(m.fit?.needBytes)} of memory
              </Text>
              {prog && (
                <Progress
                  size="small"
                  percent={prog.total ? Math.floor((prog.received / prog.total) * 100) : 0}
                  status={prog.verifying ? 'active' : undefined}
                  format={(pct) => (prog.verifying ? 'Verifying…' : `${pct}%`)}
                />
              )}
            </>
          )}
        />
      </List.Item>
    );
  };

  const section = (role) => {
    const installed = installedFor(role);
    const rec = lists[role];
    const pop = popular[role];
    return (
      <Card key={role} size="small" title={ROLES[role].title} style={{ marginBottom: 16 }}>
        <Paragraph type="secondary" style={{ fontSize: 13 }}>{ROLES[role].blurb}</Paragraph>

        {installed.length > 0 && (
          <>
            <Text strong>On this computer</Text>
            <List
              size="small"
              dataSource={installed}
              renderItem={(m) => (
                <List.Item
                  actions={[
                    inUse(m)
                      ? <Tag color="green" icon={<CheckCircleOutlined />}>In use</Tag>
                      : <Button size="small" loading={busy[m.id]} onClick={() => use(m)}>Use</Button>,
                    <Popconfirm
                      title="Delete this model?"
                      description={`Frees ${gb(m.size)}. You can download it again later.`}
                      onConfirm={() => remove(m)}
                    >
                      <Button size="small" danger icon={<DeleteOutlined />} />
                    </Popconfirm>,
                  ]}
                >
                  <List.Item.Meta title={m.label} description={`${m.repo} · ${gb(m.size)}`} />
                </List.Item>
              )}
            />
          </>
        )}

        <Text strong>Recommended</Text>
        <List
          size="small"
          loading={!rec}
          dataSource={rec || []}
          locale={{ emptyText: 'Could not reach Hugging Face. Check your connection.' }}
          renderItem={catalogRow}
        />

        <Collapse
          ghost
          style={{ marginTop: 8 }}
          onChange={(keys) => { if (keys.length && !pop) loadPopular(role); }}
          items={[{
            key: 'popular',
            label: 'Popular on Hugging Face',
            children: (
              <>
                <Space.Compact style={{ width: '100%', marginBottom: 8 }}>
                  <Input
                    placeholder="Search Hugging Face, or paste a repo (owner/name)"
                    value={pasted[role]}
                    onChange={(e) => setPasted((p) => ({ ...p, [role]: e.target.value }))}
                    onPressEnter={() => (pasted[role].includes('/') ? addPasted(role) : loadPopular(role, pasted[role]))}
                  />
                  <Button
                    icon={<SearchOutlined />}
                    onClick={() => (pasted[role].includes('/') ? addPasted(role) : loadPopular(role, pasted[role]))}
                  />
                  <Button icon={<ReloadOutlined />} onClick={() => loadPopular(role)} />
                </Space.Compact>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  Only models that fit this computer are shown. Community models are not reviewed by Ternlux —
                  check each model&apos;s licence on Hugging Face.
                </Text>
                <List
                  size="small"
                  loading={loadingPopular[role]}
                  dataSource={pop || []}
                  renderItem={catalogRow}
                />
              </>
            ),
          }]}
        />
      </Card>
    );
  };

  const memory = useMemo(() => (status?.totalMemory ? gb(status.totalMemory) : null), [status]);

  if (!api) return <Alert type="info" showIcon message="Local models are only available in the desktop app." />;
  if (!status) return <LoadingOutlined />;
  if (!status.available) {
    return (
      <Alert
        type="warning"
        showIcon
        message="Local models are not available in this build"
        description="The bundled model runner (llama-server) is missing. Use an API provider instead."
      />
    );
  }

  return (
    <div>
      {mode === 'onboarding' && (
        <>
          <Title level={4} style={{ marginTop: 0 }}>Run AI on this computer</Title>
          <Paragraph type="secondary">
            Download a model once and use Ternlux without an API key. Your data stays on this computer.
            {memory ? ` This computer has ${memory} of memory.` : ''} Smaller models are faster but less capable
            than cloud models.
          </Paragraph>
        </>
      )}
      {mode === 'settings' && memory && (
        <Paragraph type="secondary" style={{ fontSize: 13 }}>
          Models run with the bundled llama.cpp ({status.build}) and start only when used. This computer has {memory} of memory.
        </Paragraph>
      )}
      {section('chat')}
      {section('embedding')}
      {mode === 'onboarding' && status.chatIsDefault && status.chatModel && (
        <Button type="primary" size="large" onClick={() => onComplete?.()}>Continue</Button>
      )}
    </div>
  );
};

export default LocalModelManager;
