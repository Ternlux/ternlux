import React, { useState, useEffect } from 'react';
import Workflows from './components/Workflows/Workflows'
import ChatBot from './components/Chat/ChatBot';
import ApiKeySetup from './components/ApiKeySetup/ApiKeySetup';
import TermsAndConditions from './components/TermsAndConditions/TermsAndConditions';
import Settings from './components/Settings/Settings';
import { hasAnyApiKey } from './utils/apiKeyStorage';
import './App.css';

function App() {
  const [activeView, setActiveView] = useState('workflow');
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);

  // null = still checking, false = not yet accepted/set, true = ready
  const [termsAccepted, setTermsAccepted] = useState(null);
  const [apiKeyReady, setApiKeyReady] = useState(null);

  useEffect(() => {
    const init = async () => {
      let accepted = false;
      try {
        if (window.electronAPI?.terms?.get) {
          const record = await window.electronAPI.terms.get();
          accepted = !!record?.accepted;
        } else {
          accepted = localStorage.getItem('ternlux_terms_accepted') === 'true';
        }
      } catch (e) {
        console.warn('Could not read terms acceptance:', e);
        accepted = localStorage.getItem('ternlux_terms_accepted') === 'true';
      }
      setTermsAccepted(accepted);

      // Push the persisted analytics preference to the main process so it
      // can gate event sending. Default to off if it has never been set.
      try {
        const optIn = localStorage.getItem('ternlux_analytics_opt_in') === 'true';
        await window.electronAPI?.analytics?.setOptIn(optIn);
      } catch (e) {
        console.warn('Could not sync analytics preference:', e);
      }

      // An LLM API key is required to use the app; signing in is optional
      // (it only unlocks plugins) and is offered as step 2 of onboarding.
      const hasLlmKey = await hasAnyApiKey();
      setApiKeyReady(hasLlmKey);
    };
    init();
  }, []);

  // While we check storage, render nothing (avoids flash of main UI)
  if (termsAccepted === null || apiKeyReady === null) return null;

  if (!termsAccepted) {
    return (
      <TermsAndConditions
        onComplete={() => setTermsAccepted(true)}
      />
    );
  }

  if (!apiKeyReady) {
    return (
      <ApiKeySetup
        onComplete={() => setApiKeyReady(true)}
      />
    );
  }

  return (
    <div className="app">
    <Workflows />
    </div>
    // <div className="app">
    //   <nav className="app-nav">
    //     {/* <div className="app-nav-brand">Ternlux</div> */}
    //     <div className="app-nav-tabs">
    //       {/* <button
    //         className={`app-nav-tab${activeView === 'dashboard' ? ' active' : ''}`}
    //         onClick={() => setActiveView('dashboard')}
    //       >
    //         Dashboard
    //       </button> */}
    //       <button
    //         className={`app-nav-tab${activeView === 'workflow' ? ' active' : ''}`}
    //         onClick={() => setActiveView('workflow')}
    //       >
    //         Workflow
    //       </button>
    //     </div>
    //     <div className="app-nav-actions">
    //       <button
    //         className="app-nav-settings-btn"
    //         onClick={() => setIsSettingsOpen(true)}
    //         title="Settings"
    //       >
    //         ⚙️
    //       </button>
    //     </div>
    //   </nav>
    //   <main className="app-content">
    //     {activeView === 'dashboard' ? <ChatBot /> : <Workflows />}
    //   </main>

    //   {/* Settings Modal */}
    //   {isSettingsOpen && (
    //     <Settings onClose={() => setIsSettingsOpen(false)} />
    //   )}
    // </div>
  );
}

export default App;
