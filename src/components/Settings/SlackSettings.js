import React, { useCallback, useEffect, useState } from 'react';
import { Card, Input, Button, Switch, Space, Typography, Alert, List, Tag, Steps, message } from 'antd';
import {
  SlackOutlined, DeleteOutlined, KeyOutlined, CopyOutlined, ExportOutlined, CheckCircleFilled,
} from '@ant-design/icons';

const { Title, Paragraph, Text } = Typography;

/**
 * Settings → Slack. Connects THIS computer's own Slack app to the chat
 * assistant (public/slack/index.js): name the bot, create the app from a
 * generated manifest, paste its two tokens, switch it on, pair your account.
 * One app per computer keeps each computer's bot separate in Slack.
 */
const SlackSettings = () => {
  const api = window.electronAPI?.slack;
  const [status, setStatus] = useState(null);
  const [name, setName] = useState('');
  const [manifest, setManifest] = useState(null);
  const [appToken, setAppToken] = useState('');
  const [botToken, setBotToken] = useState('');
  const [saving, setSaving] = useState(false);
  // Setup is one step at a time: 0 name & create the app, 1 app-level token,
  // 2 install & bot token. A step appears only once the one before is done.
  const [setupStep, setSetupStep] = useState(0);

  const refresh = useCallback(async () => {
    if (!api) return;
    try { setStatus(await api.status()); } catch (err) { message.error(err.message); }
  }, [api]);

  // Poll while open, so a pairing done in Slack shows up here.
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 3000);
    return () => clearInterval(t);
  }, [refresh]);

  useEffect(() => {
    if (status && !name) setName(status.appName || status.defaultName);
  }, [status, name]);

  if (!api) {
    return <Alert type="info" showIcon message="The Slack bridge is only available in the desktop app." />;
  }
  if (!status) return null;

  const prepare = async () => {
    const m = await api.manifest(name);
    setName(m.appName);
    setManifest(m);
    return m;
  };

  const openCreate = async () => {
    const m = await prepare();
    window.open(m.createUrl, '_blank', 'noopener');
    setSetupStep(1);
  };

  const copyManifest = async () => {
    const m = await prepare();
    try {
      await navigator.clipboard.writeText(m.json);
      message.success('Manifest copied — paste it into "From an app manifest" in Slack.');
    } catch (_err) {
      message.error('Could not copy the manifest.');
    }
    setSetupStep(1);
  };

  const appTokenOk = /^xapp-/.test(appToken.trim());
  const nextFromAppToken = () => {
    if (!appTokenOk) {
      message.error('That is not an app-level token — it starts with xapp-.');
      return;
    }
    setSetupStep(2);
  };

  const connect = async () => {
    setSaving(true);
    try {
      const res = await api.setTokens(appToken, botToken);
      if (res.success) {
        setAppToken('');
        setBotToken('');
        setStatus(res.status);
        message.success(`Connected to ${res.status.bot?.team}`);
      } else {
        message.error(res.message);
      }
    } finally {
      setSaving(false);
    }
  };

  const step = !status.configured ? setupStep : (status.users.length ? 4 : 3);
  const botName = status.bot?.name || status.appName;
  const handle = manifest?.manifest.features.bot_user.display_name;

  // A finished setup step, folded to one line with a way back to it.
  const Done = ({ children, onChange }) => (
    <Card size="small" style={{ marginBottom: 12, background: '#f6ffed', borderColor: '#b7eb8f' }}>
      <Space style={{ width: '100%', justifyContent: 'space-between' }}>
        <Text><CheckCircleFilled style={{ color: '#52c41a', marginRight: 8 }} />{children}</Text>
        <Button size="small" type="link" onClick={onChange}>Change</Button>
      </Space>
    </Card>
  );

  return (
    <div style={{ maxWidth: 760 }}>
      <Title level={3}><SlackOutlined /> Slack</Title>
      <Paragraph type="secondary">
        Ask the chat assistant questions, get charts back, build workflows and send it data files — from a Slack
        direct message. Each computer gets its own Slack bot, named after it, so the bot you message is the computer
        that answers. Ternlux has to be open on this computer for its bot to answer.
      </Paragraph>

      <Steps
        size="small"
        current={step}
        style={{ marginBottom: 24 }}
        items={[{ title: 'Create the app' }, { title: 'App-level token' }, { title: 'Bot token' }, { title: 'Pair' }, { title: 'Chat' }]}
      />

      {!status.configured && setupStep > 0 && (
        <Done onChange={() => setSetupStep(0)}>
          Slack app <b>{manifest?.appName || name}</b>{handle ? <> · <Text code>@{handle}</Text></> : null}
        </Done>
      )}
      {!status.configured && setupStep > 1 && (
        <Done onChange={() => setSetupStep(1)}>App-level token entered</Done>
      )}

      {!status.configured && setupStep === 0 && (
        <Card title="Step 1 — Name this computer's bot and create the Slack app" style={{ marginBottom: 16 }}>
          <Space direction="vertical" style={{ width: '100%' }}>
            <Paragraph style={{ marginBottom: 0 }}>
              This is how the bot appears in Slack. Include the computer's name so it is clear which machine answers.
            </Paragraph>
            <Input value={name} maxLength={35} showCount onChange={(e) => { setName(e.target.value); setManifest(null); }} />
            <Space wrap>
              <Button type="primary" icon={<ExportOutlined />} onClick={openCreate}>Create the Slack app</Button>
              <Button icon={<CopyOutlined />} onClick={copyManifest}>Copy manifest instead</Button>
            </Space>
            <Text type="secondary">
              "Create the Slack app" opens Slack with everything filled in — pick your workspace and confirm. If the page
              opens empty, choose <i>Create New App → From an app manifest</i> and paste the copied manifest.
              Some workspaces need an admin to approve new apps.
            </Text>
          </Space>
        </Card>
      )}

      {!status.configured && setupStep === 1 && (
        <Card title="Step 2 — Copy the app-level token" style={{ marginBottom: 16 }}>
          <Space direction="vertical" style={{ width: '100%' }}>
            <Paragraph style={{ marginBottom: 0 }}>
              On your new app's page in Slack, open <i>Basic Information</i>, scroll to <i>App-Level Tokens</i> and
              click <i>Generate Token and Scopes</i>. Give it any name, add the scope <Text code>connections:write</Text>,
              generate it, and copy the token — it starts with <Text code>xapp-</Text>.
            </Paragraph>
            <Input.Password prefix={<KeyOutlined />} placeholder="xapp-…" value={appToken}
              onChange={(e) => setAppToken(e.target.value)} onPressEnter={nextFromAppToken} autoComplete="off" />
            <Button type="primary" disabled={!appToken.trim()} onClick={nextFromAppToken}>Next</Button>
          </Space>
        </Card>
      )}

      {!status.configured && setupStep === 2 && (
        <Card title="Step 3 — Install the app and copy the bot token" style={{ marginBottom: 16 }}>
          <Space direction="vertical" style={{ width: '100%' }}>
            <Paragraph style={{ marginBottom: 0 }}>
              Still on the app's page, open <i>Install App</i> and click <i>Install to Workspace</i>, then allow it.
              Copy the <i>Bot User OAuth Token</i> that appears — it starts with <Text code>xoxb-</Text>.
            </Paragraph>
            <Input.Password prefix={<KeyOutlined />} placeholder="xoxb-…" value={botToken}
              onChange={(e) => setBotToken(e.target.value)} onPressEnter={connect} autoComplete="off" />
            <Button type="primary" loading={saving} disabled={!botToken.trim()} onClick={connect}>Connect</Button>
            <Text type="secondary">Both tokens are encrypted on this computer.</Text>
          </Space>
        </Card>
      )}

      {status.configured && (
        <Card title="Slack app" style={{ marginBottom: 16 }}>
          <Space direction="vertical" style={{ width: '100%' }}>
            <Text><b>{botName}</b> in <b>{status.bot?.team}</b></Text>
            <Button danger onClick={async () => { setSetupStep(0); setStatus(await api.clear()); }}>Disconnect this Slack app</Button>
          </Space>
        </Card>
      )}

      {status.configured && (
        <Card title="Bridge" style={{ marginBottom: 16 }}>
          <Space>
            <Switch checked={status.enabled} onChange={async (on) => setStatus(await api.setEnabled(on))} />
            <Text>
              {!status.enabled ? 'Off' : (status.connected ? 'On — connected to Slack' : 'On — connecting…')}
            </Text>
          </Space>
        </Card>
      )}

      {status.configured && (
        <Card title="Who can talk to it" style={{ marginBottom: 16 }}>
          <Paragraph type="secondary">
            Anyone in the workspace can message a Slack bot, and this one can read your connections — so only paired
            accounts get answers. Mentions in channels are not answered yet.
          </Paragraph>
          {status.pairing ? (
            <Alert
              type="info"
              showIcon
              style={{ marginBottom: 16 }}
              message={<span>In Slack, open a direct message with <b>{botName}</b> and send <Text code copyable>{`pair ${status.pairing.code}`}</Text></span>}
              description={<Text type="secondary">The code works once and expires at {new Date(status.pairing.expiresAt).toLocaleTimeString()}.</Text>}
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
          <li>Answer questions about your connections, workflows and runs. Each direct message is one ongoing conversation; send <Text code>new</Text> to start over and <Text code>cancel</Text> to stop what it is doing. Conversations are saved in the chat history.</li>
          <li>Send charts as images and tables as CSV files.</li>
          <li>Ask before running generated code: <i>Run it</i> / <i>Don't run</i> buttons, with <i>View code</i> to read it.</li>
          <li>Build new workflows from a plan (<i>Build it</i> / <i>Cancel</i>); changes to existing workflows happen in the app.</li>
          <li>Add a CSV, Excel, JSON, Parquet or Avro file you send it (up to 100 MB) as a connection; text sent with the file names it.</li>
        </ul>
      </Card>
    </div>
  );
};

export default SlackSettings;
