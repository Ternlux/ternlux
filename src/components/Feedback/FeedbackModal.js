import React, { useState } from 'react';
import { Modal, Form, Input, Segmented, Button, Alert, Typography } from 'antd';
import { GithubOutlined, RedditOutlined, MailOutlined, CheckCircleFilled } from '@ant-design/icons';

const { Text, Paragraph } = Typography;

// Where feedback can go. The links open in the browser (Electron's window
// open handler sends target="_blank" to the system browser); the form posts
// to the backend's /api/feedback, which emails it to the team.
const BACKEND_URL = process.env.REACT_APP_BACKEND_URL || 'https://api.ternlux.com';
const GITHUB_DISCUSSIONS_URL = 'https://github.com/Ternlux/ternlux/discussions/new/choose';
const REDDIT_URL = 'https://www.reddit.com/r/TernluxCommunity/';

const CATEGORIES = [
  { label: 'Bug', value: 'bug' },
  { label: 'Idea', value: 'idea' },
  { label: 'Question', value: 'question' },
  { label: 'Other', value: 'other' },
];

// "Ternlux/1.0.0" is in Electron's user agent; a plain browser has none.
const appVersion = () => (navigator.userAgent.match(/Ternlux\/([\d.]+)/i) || [])[1] || '';
const platform = () => navigator.userAgentData?.platform || navigator.platform || '';

const ChannelLink = ({ href, icon, title, text }) => (
  <a
    href={href}
    target="_blank"
    rel="noreferrer"
    style={{
      flex: 1, display: 'flex', gap: 10, alignItems: 'flex-start',
      padding: '10px 12px', border: '1px solid #e2e6eb', borderRadius: 6,
      color: 'inherit', textDecoration: 'none',
    }}
  >
    <span style={{ fontSize: 18, lineHeight: 1 }}>{icon}</span>
    <span>
      <Text strong style={{ display: 'block' }}>{title}</Text>
      <Text type="secondary" style={{ fontSize: 12 }}>{text}</Text>
    </span>
  </a>
);

/**
 * The Feedback popup next to the Settings gear: open a GitHub issue, post on
 * Reddit, or send a message straight to the team.
 */
const FeedbackModal = ({ open, onClose }) => {
  const [form] = Form.useForm();
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);
  const [sent, setSent] = useState(false);

  const close = () => {
    onClose();
    // Reset after the close animation, so the form doesn't flash empty.
    setTimeout(() => { form.resetFields(); setSent(false); setError(null); }, 300);
  };

  const submit = async (values) => {
    setSending(true);
    setError(null);
    try {
      const res = await fetch(`${BACKEND_URL}/api/feedback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...values, appVersion: appVersion(), platform: platform() }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success) throw new Error(data.error || `The server answered ${res.status}.`);
      setSent(true);
    } catch (err) {
      setError(err.message === 'Failed to fetch'
        ? 'Could not reach the Ternlux server. Check your connection and try again.'
        : err.message);
    } finally {
      setSending(false);
    }
  };

  return (
    <Modal open={open} onCancel={close} footer={null} title="Send feedback" width={520} destroyOnClose>
      {sent ? (
        <div style={{ textAlign: 'center', padding: '24px 0 8px' }}>
          <CheckCircleFilled style={{ fontSize: 36, color: '#059669' }} />
          <Paragraph style={{ marginTop: 12, marginBottom: 4 }}><Text strong>Thanks — your feedback was sent.</Text></Paragraph>
          <Paragraph type="secondary">If you left an email address, we may reply to it.</Paragraph>
          <Button onClick={close}>Close</Button>
        </div>
      ) : (
        <>
          <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
            <ChannelLink href={GITHUB_DISCUSSIONS_URL} icon={<GithubOutlined />} title="GitHub" text="Report a bug or suggest a feature in Discussions" />
            <ChannelLink href={REDDIT_URL} icon={<RedditOutlined style={{ color: '#ff4500' }} />} title="Reddit" text="Ask questions and share ideas with the community" />
          </div>

          <Text type="secondary" style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10 }}>
            <MailOutlined /> Or send it straight to the team:
          </Text>

          <Form form={form} layout="vertical" onFinish={submit} initialValues={{ category: 'bug' }} requiredMark={false}>
            <Form.Item name="category" style={{ marginBottom: 12 }}>
              <Segmented block options={CATEGORIES} />
            </Form.Item>
            <Form.Item
              name="message"
              label="What's on your mind?"
              rules={[
                { required: true, message: 'Please write your feedback.' },
                { min: 5, message: 'Please write a little more.' },
              ]}
            >
              <Input.TextArea rows={5} maxLength={5000} showCount placeholder="What happened, what you expected, or what you'd like to see…" />
            </Form.Item>
            <div style={{ display: 'flex', gap: 8 }}>
              <Form.Item name="name" label="Name (optional)" style={{ flex: 1 }}>
                <Input maxLength={200} />
              </Form.Item>
              <Form.Item
                name="email"
                label="Email (optional, for a reply)"
                style={{ flex: 1 }}
                rules={[{ type: 'email', message: 'That email address does not look right.' }]}
              >
                <Input maxLength={200} />
              </Form.Item>
            </div>
            {/* Honeypot: hidden from people, filled in by bots. */}
            <Form.Item name="website" hidden><Input tabIndex={-1} autoComplete="off" /></Form.Item>
            {error && <Alert type="error" showIcon message={error} style={{ marginBottom: 12 }} />}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <Button onClick={close}>Cancel</Button>
              <Button type="primary" htmlType="submit" loading={sending}>Send feedback</Button>
            </div>
          </Form>
        </>
      )}
    </Modal>
  );
};

export default FeedbackModal;
