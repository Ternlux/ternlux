import React, { useState, useCallback } from 'react';
import WorkflowsTab from './WorkflowsTab';
import ConnectionsTab from './ConnectionsTab';
import ExecutionTab from './ExecutionTab';
import Settings from '../Settings/Settings';
import ChatAssistant from '../Chat/ChatAssistant';
import { C, SANS } from './_designShared';
import './Workflows.css';

const Workflows = () => {
  const [activeTab, setActiveTab] = useState('workflows');
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  // What the user is currently focused on — passed down so each tab can
  // notify the chat assistant when the user clicks a workflow / connection /
  // execution. Shape: { kind, id, name, summary }.
  const [chatContext, setChatContext] = useState(null);

  const reportContext = useCallback((ctx) => setChatContext(ctx || null), []);

  const TABS = [
    { id: 'workflows',   label: 'Workflows',   render: () => <WorkflowsTab   onContextChange={reportContext} /> },
    { id: 'connections', label: 'Connections', render: () => <ConnectionsTab onContextChange={reportContext} /> },
    { id: 'execution',   label: 'Executions',  render: () => <ExecutionTab   onContextChange={reportContext} /> },
  ];
  const active = TABS.find(t => t.id === activeTab) || TABS[0];

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', height: '100vh',
      background: C.surface, fontFamily: SANS, overflow: 'hidden',
    }}>
      {/* Tab bar */}
      <div style={{
        height: 44, background: '#fff', borderBottom: `1px solid ${C.border}`,
        display: 'flex', alignItems: 'stretch', padding: '0 16px', gap: 2, flexShrink: 0
      }}>
        {TABS.map(t => {
          const isActive = activeTab === t.id;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => setActiveTab(t.id)}
              style={{
                display: 'flex', alignItems: 'center',
                padding: '0 14px',
                background: 'none', border: 'none', cursor: 'pointer',
                fontSize: 12, fontFamily: SANS, letterSpacing: '-0.01em',
                fontWeight: isActive ? 600 : 500,
                color: isActive ? C.text : C.muted,
                borderBottom: isActive ? `2px solid ${C.accent}` : '2px solid transparent',
                transition: 'color 0.15s, border-color 0.15s',
              }}
              onMouseOver={e => { if (!isActive) e.currentTarget.style.color = C.text; }}
              onMouseOut={e => { if (!isActive) e.currentTarget.style.color = C.muted; }}
            >
              {t.label}
            </button>
          );
        })}

        {/* Right-aligned actions */}
        <div style={{ flex: 1 }} />
        <button
          type="button"
          onClick={() => setIsSettingsOpen(true)}
          title="Settings"
          aria-label="Settings"
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            alignSelf: 'center',
            width: 28, height: 28, borderRadius: 4,
            background: 'none', border: 'none', cursor: 'pointer',
            color: C.muted, transition: 'background 0.15s, color 0.15s',
          }}
          onMouseOver={e => {
            e.currentTarget.style.background = C.s2;
            e.currentTarget.style.color = C.text;
          }}
          onMouseOut={e => {
            e.currentTarget.style.background = 'none';
            e.currentTarget.style.color = C.muted;
          }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </button>
      </div>

      {/* Tab content */}
      <div style={{ flex: 1, overflow: 'hidden' }}>
        {active.render()}
      </div>

      {isSettingsOpen && (
        <Settings onClose={() => setIsSettingsOpen(false)} />
      )}

      <ChatAssistant activeContext={chatContext} />
    </div>
  );
};

export default Workflows;
