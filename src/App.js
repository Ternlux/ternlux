import React, { useState, useEffect } from 'react';
import Workflows from './components/Workflows/Workflows'
import ChatBot from './components/Chat/ChatBot';
import ApiKeySetup from './components/ApiKeySetup/ApiKeySetup';
import Settings from './components/Settings/Settings';
import { hasAnyApiKey } from './utils/apiKeyStorage';
import './App.css';

function App() {
  const [activeView, setActiveView] = useState('dashboard');
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);

  // null = still checking, false = not set (show setup), true = ready
  const [apiKeyReady, setApiKeyReady] = useState(null);

  useEffect(() => {
    const checkKeys = async () => {
      const hasLlmKey = await hasAnyApiKey();
      const hasAuthToken = Boolean(localStorage.getItem('auth-token'));
      setApiKeyReady(hasLlmKey || hasAuthToken);
    };
    checkKeys();
  }, []);

  // While we check storage, render nothing (avoids flash of main UI)
  if (apiKeyReady === null) return null;

  if (!apiKeyReady) {
    return (
      <ApiKeySetup
        onComplete={() => setApiKeyReady(true)}
      />
    );
  }

  return (
    <div className="app">
      <nav className="app-nav">
        {/* <div className="app-nav-brand">DagFlux</div> */}
        <div className="app-nav-tabs">
          <button
            className={`app-nav-tab${activeView === 'dashboard' ? ' active' : ''}`}
            onClick={() => setActiveView('dashboard')}
          >
            Dashboard
          </button>
          <button
            className={`app-nav-tab${activeView === 'workflow' ? ' active' : ''}`}
            onClick={() => setActiveView('workflow')}
          >
            Workflow
          </button>
        </div>
        <div className="app-nav-actions">
          <button
            className="app-nav-settings-btn"
            onClick={() => setIsSettingsOpen(true)}
            title="Settings"
          >
            ⚙️
          </button>
        </div>
      </nav>
      <main className="app-content">
        {activeView === 'dashboard' ? <ChatBot /> : <Workflows />}
      </main>

      {/* Settings Modal */}
      {isSettingsOpen && (
        <Settings onClose={() => setIsSettingsOpen(false)} />
      )}
    </div>
  );
}

export default App;
