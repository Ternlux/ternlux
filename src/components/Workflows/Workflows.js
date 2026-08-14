import React, { useState, useCallback, useEffect } from 'react';
import WorkflowsTab from './WorkflowsTab';
import ConnectionsTab from './ConnectionsTab';
import ExecutionTab from './ExecutionTab';
import Settings from '../Settings/Settings';
import { C, SANS } from './_designShared';
import './Workflows.css';

// The ChatAssistant lives in App.js (it can pin itself as a sibling column of
// this whole view), so the state it shares with the tabs is owned up there and
// handed back down: `onChatContextChange` reports upwards, and `builtWorkflow`
// is the assistant's Accept-plan result coming in.
const Workflows = ({
  onChatContextChange = () => {},
  builtWorkflow = null, // { id, bump } | null
}) => {
  const [activeTab, setActiveTab] = useState('workflows');
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState('account');

  // Deeply nested components (e.g. ConnectionTypeSelector's "Login to access")
  // request Settings via this window event instead of prop drilling.
  useEffect(() => {
    const handler = (e) => {
      setSettingsTab(e.detail?.tab || 'account');
      setIsSettingsOpen(true);
    };
    window.addEventListener('ternlux:open-settings', handler);
    return () => window.removeEventListener('ternlux:open-settings', handler);
  }, []);
  // What the user is currently focused on — each tab reports the workflow /
  // connection / execution the user clicked, and it goes up to the assistant.
  // Shape: { kind, id, name, summary }.
  const reportContext = useCallback((ctx) => onChatContextChange(ctx || null), [onChatContextChange]);

  // The assistant's Accept-plan build arrives as `builtWorkflow`: bounce to the
  // Workflows tab and hand the id to WorkflowsTab so it can refresh + open it.
  // The bump counter forces the effect to fire even when the same workflow id
  // is "built" twice in a row.
  const [pendingOpenWorkflow, setPendingOpenWorkflow] = useState(null); // { id, bump }
  useEffect(() => {
    if (!builtWorkflow?.id) return;
    setActiveTab('workflows');
    setPendingOpenWorkflow({ id: builtWorkflow.id, bump: builtWorkflow.bump });
  }, [builtWorkflow]);

  // Switching tabs unmounts the previous tab (and any editor/panel it had
  // open), so whatever it had put in focus is gone — clear it too.
  useEffect(() => { onChatContextChange(null); }, [activeTab, onChatContextChange]);

  const clearPendingOpen = useCallback(() => setPendingOpenWorkflow(null), []);

  // A data file dropped on the Workflows tab belongs to Connections — that tab
  // owns the import popups. Bounce there and hand the batch over; the bump
  // counter makes dropping the same file twice re-trigger the flow.
  const [pendingDroppedFiles, setPendingDroppedFiles] = useState(null); // { files, bump }
  const handleFilesDropped = useCallback((files) => {
    setPendingDroppedFiles((prev) => ({ files, bump: (prev?.bump || 0) + 1 }));
    setActiveTab('connections');
  }, []);
  const clearPendingFiles = useCallback(() => setPendingDroppedFiles(null), []);

  const TABS = [
    { id: 'workflows',   label: 'Workflows',   render: () => (
      <WorkflowsTab
        onContextChange={reportContext}
        pendingOpenWorkflow={pendingOpenWorkflow}
        onPendingOpenHandled={clearPendingOpen}
        onFilesDropped={handleFilesDropped}
      />
    ) },
    { id: 'connections', label: 'Connections', render: () => (
      <ConnectionsTab
        onContextChange={reportContext}
        pendingFiles={pendingDroppedFiles}
        onPendingFilesHandled={clearPendingFiles}
      />
    ) },
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
          onClick={() => { setSettingsTab('account'); setIsSettingsOpen(true); }}
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
        <Settings initialTab={settingsTab} onClose={() => setIsSettingsOpen(false)} />
      )}
    </div>
  );
};

export default Workflows;
