import React, { useCallback, useEffect, useState } from 'react';
import { Card, Input, Button, Switch, Space, Typography, Alert, List, Tag, Steps, message } from 'antd';
import { SendOutlined, DeleteOutlined, KeyOutlined, LinkOutlined } from '@ant-design/icons';

const { Title, Paragraph, Text } = Typography;

/**
 * Settings → Telegram. Connects a Telegram bot to the chat assistant
 * (public/telegram/index.js): paste the bot token, switch it on, pair your
 * Telegram account with a one-time code.
 */
const TelegramSettings = () => {
  const api = window.electronAPI?.telegram;
  const [status, setStatus] = useState(null);
  const [token, setToken] = useState('');
  const [saving, setSaving] = useState(false);

  const refresh = useCallback(async () => {
    if (!api) return;
    try { setStatus(await api.status()); } catch (err) { message.error(err.message); }
  }, [api]);

  // Poll while open, so a pairing done in Telegram shows up here.
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 3000);
    return () => clearInterval(t);
  }, [refresh]);

  if (!api) {
    return <Alert type="info" showIcon message="The Telegram bridge is only available in the desktop app." />;
  }
  if (!status) return null;

  const saveToken = async () => {
    setSaving(true);
    try {
      const res = await api.setToken(token);
      if (res.success) {
        setToken('');
        setStatus(res.status);
        message.success(`Connected to @${res.status.bot?.username}`);
      } else {
        message.error(res.message);
      }
    } finally {
      setSaving(false);
    }
  };

  const step = !status.configured ? 0 : (status.users.length ? 3 : 2);

  return (
    <div style={{ maxWidth: 720 }}>
      <Title level={3}><SendOutlined /> Telegram</Title>
      <Paragraph type="secondary">
        Ask the chat assistant questions, get charts back, and send it data files to add as connections —
        from a Telegram chat. Ternlux has to be open on this computer for the bot to answer.
      </Paragraph>

      <Steps
        size="small"
        current={step}
        style={{ marginBottom: 24 }}
        items={[{ title: 'Create a bot' }, { title: 'Switch it on' }, { title: 'Pair your account' }, { title: 'Chat' }]}
      />

      <Card title="1. Bot token" style={{ marginBottom: 16 }}>
        {status.configured ? (
          <Space direction="vertical" style={{ width: '100%' }}>
            <Text>Connected to <a href={`https://t.me/${status.bot?.username}`} target="_blank" rel="noreferrer">@{status.bot?.username}</a></Text>
            <Button danger onClick={async () => setStatus(await api.clearToken())}>Remove bot</Button>
          </Space>
        ) : (
          <Space direction="vertical" style={{ width: '100%' }}>
            <Paragraph style={{ marginBottom: 8 }}>
              In Telegram, open <a href="https://t.me/BotFather" target="_blank" rel="noreferrer">@BotFather</a>,
              send <Text code>/newbot</Text>, pick a name and a username ending in <Text code>bot</Text>,
              then paste the token it gives you here. The token is encrypted on this computer.
            </Paragraph>
            <Space.Compact style={{ width: '100%' }}>
              <Input.Password
                prefix={<KeyOutlined />}
                placeholder="123456789:AA…"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                onPressEnter={saveToken}
                autoComplete="off"
              />
              <Button type="primary" loading={saving} disabled={!token.trim()} onClick={saveToken}>Connect</Button>
            </Space.Compact>
          </Space>
        )}
      </Card>

      {status.configured && (
        <Card title="2. Bridge" style={{ marginBottom: 16 }}>
          <Space>
            <Switch checked={status.enabled} onChange={async (on) => setStatus(await api.setEnabled(on))} />
            <Text>{status.enabled ? (status.running ? 'On — listening for messages' : 'On — starting…') : 'Off'}</Text>
          </Space>
        </Card>
      )}

      {status.configured && (
        <Card title="3. Who can talk to it" style={{ marginBottom: 16 }}>
          <Paragraph type="secondary">
            Only paired Telegram accounts get answers — the bot can read your connections, so nobody else should
            be able to use it. Group chats are not supported.
          </Paragraph>
          {status.pairing ? (
            <Alert
              type="info"
              showIcon
              style={{ marginBottom: 16 }}
              message={<span>Send <Text code copyable>{`/pair ${status.pairing.code}`}</Text> to @{status.bot?.username}</span>}
              description={(
                <Space direction="vertical">
                  {status.pairing.link && (
                    <a href={status.pairing.link} target="_blank" rel="noreferrer"><LinkOutlined /> Or open this link on your phone</a>
                  )}
                  <Text type="secondary">The code works once and expires at {new Date(status.pairing.expiresAt).toLocaleTimeString()}.</Text>
                </Space>
              )}
            />
          ) : (
            <Button onClick={async () => setStatus(await api.newPairingCode())} style={{ marginBottom: 16 }}>
              Create a pairing code
            </Button>
          )}
          <List
            size="small"
            bordered
            locale={{ emptyText: 'No accounts paired yet.' }}
            dataSource={status.users}
            renderItem={(u) => (
              <List.Item actions={[
                <Button key="remove" size="small" type="text" danger icon={<DeleteOutlined />}
                  onClick={async () => setStatus(await api.removeUser(u.id))}>Remove</Button>,
              ]}>
                <Space>
                  <Text strong>{u.name || u.username || u.id}</Text>
                  {u.username && <Tag>@{u.username}</Tag>}
                  <Text type="secondary">paired {new Date(u.pairedAt).toLocaleDateString()}</Text>
                </Space>
              </List.Item>
            )}
          />
        </Card>
      )}

      <Card title="What it can do" size="small">
        <ul style={{ paddingLeft: 18, margin: 0 }}>
          <li>Answer questions about your connections, workflows and runs — each Telegram chat is one ongoing conversation; send <Text code>/new</Text> to start over. Conversations are saved in the chat history.</li>
          <li>Send charts as images and tables as CSV files.</li>
          <li>Ask before running generated code: you get <i>Run it</i> / <i>Don't run</i> buttons.</li>
          <li>Add a CSV, Excel, JSON, Parquet or Avro file you send it (up to 20 MB) as a connection; a caption names it.</li>
          <li>Workflow plans are drafted, but building them happens in the app.</li>
        </ul>
      </Card>
    </div>
  );
};

export default TelegramSettings;
