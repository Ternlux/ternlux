import React, { useState, useEffect, useMemo, useRef } from 'react';
import { Modal, message, Spin } from 'antd';
import { C, MONO, SANS, I } from './_designShared';
import { isLoggedIn } from '../../utils/authService';

const LOGO_PREFIX = 'http://www.ternlux.com/wp-content/uploads/2026/04/';

// Source of truth: connectors mirror the keys/categories used elsewhere in
// the app. `img` is set only for connectors covered by the ternlux.com logo
// list; everything else falls back to monogram letters.
const CONNECTION_TYPES = [
  // Local files
  { key: 'spreadsheet', title: 'CSV / Excel',     description: 'Import CSV or Excel files into local SQLite database', category: 'file', img: LOGO_PREFIX + 'CSV.png',  fileBased: true, tone: '#1890ff' },
  { key: 'json',        title: 'JSON',            description: 'Import JSON files into local NeDB database',           category: 'file', img: LOGO_PREFIX + 'JSON.png', fileBased: true, tone: '#fa8c16' },
  { key: 'sqlite',      title: 'SQLite',          description: 'Connect to an existing SQLite database file',          category: 'file', letters: 'SQ', tone: '#0f80cc', fileBased: true },
  { key: 'nedb',        title: 'NeDB',            description: 'Connect to an existing NeDB database file',            category: 'file', letters: 'ND', tone: '#52c41a', fileBased: true },
  { key: 'lancedb',     title: 'LanceDB',         description: 'Connect to local LanceDB vector database',             category: 'file', img: LOGO_PREFIX + 'LanceDB.png', tone: '#7c3aed', fileBased: true },
  { key: 'parquet',     title: 'Parquet',         description: 'Import Parquet files into local SQLite database',      category: 'file', letters: 'PQ', tone: '#9254de', fileBased: true },
  { key: 'avro',        title: 'Avro',            description: 'Import Avro files into local SQLite database',         category: 'file', letters: 'AV', tone: '#eb2f96', fileBased: true },

  // Databases
  { key: 'postgres',  title: 'PostgreSQL',      description: 'Connect to a PostgreSQL database',                category: 'database', img: LOGO_PREFIX + 'PostgreSQL.png',           tone: '#336791' },
  { key: 'mysql',     title: 'MySQL / MariaDB', description: 'Connect to a MySQL or MariaDB database',          category: 'database', img: LOGO_PREFIX + 'MySQL.png',                tone: '#e48b00' },
  { key: 'mssql',     title: 'SQL Server',      description: 'Connect to a Microsoft SQL Server database',      category: 'database', img: LOGO_PREFIX + 'Microsoft_SQL_Server.png', tone: '#0078d4' },
  { key: 'mongodb',   title: 'MongoDB',         description: 'Connect to a MongoDB database or Atlas cluster',  category: 'database', img: LOGO_PREFIX + 'MongoDB.png',              tone: '#00a550' },
  { key: 'redshift',  title: 'Amazon Redshift', description: 'Connect to an Amazon Redshift data warehouse',    category: 'database', img: LOGO_PREFIX + 'Amazon_Redshift.png',      tone: '#ff9900' },
  { key: 'bigquery',  title: 'Google BigQuery', description: 'Connect to Google BigQuery data warehouse',       category: 'database', img: LOGO_PREFIX + 'Google_BigQuery.png',      tone: '#4285f4' },
  { key: 'snowflake', title: 'Snowflake',       description: 'Connect to a Snowflake data warehouse',           category: 'database', img: LOGO_PREFIX + 'Snowflake.png',            tone: '#29b5e8' },

  // Cloud storage
  { key: 's3',           title: 'Amazon S3',            description: 'Connect to Amazon S3 object storage', category: 'storage', img: LOGO_PREFIX + 'Amazon_S3.png',            tone: '#ff9900' },
  { key: 'gcs',          title: 'Google Cloud Storage', description: 'Connect to Google Cloud Storage',     category: 'storage', img: LOGO_PREFIX + 'Google_Cloud_Storage.png', tone: '#4285f4' },
  { key: 'azure-blob',   title: 'Azure Blob Storage',   description: 'Connect to Azure Blob Storage',       category: 'storage', img: LOGO_PREFIX + 'Azure_blob.png',           tone: '#0078d4' },
  { key: 'dropbox',      title: 'Dropbox',              description: 'Connect to Dropbox cloud storage',    category: 'storage', img: 'http://www.ternlux.com/wp-content/uploads/2026/05/Dropbox-scaled.png', letters: 'DB', tone: '#0061ff' },
  { key: 'google-drive', title: 'Google Drive',         description: 'Connect to Google Drive',             category: 'storage', letters: 'GD', tone: '#34a853' },
  { key: 'onedrive',     title: 'OneDrive',             description: 'Connect to Microsoft OneDrive',       category: 'storage', letters: 'OD', tone: '#0078d4' },

  // APIs
  { key: 'google-sheets', title: 'Google Sheets', description: 'Connect to Google Sheets via OAuth2.0',                                  category: 'api', img: LOGO_PREFIX + 'Google_Sheets.png', tone: '#34a853' },
  { key: 'rest-api',      title: 'REST API',      description: 'Generic HTTP endpoint — URL + auth here, request authored on the node', category: 'api', letters: 'API', tone: '#2563eb' },

  // Vector
  { key: 'pinecone', title: 'Pinecone', description: 'Connect to Pinecone vector database', category: 'vector', letters: 'PC', tone: '#0f172a' },
];

const SECTIONS = [
  { key: 'file',     title: 'Local Files',          desc: 'Files imported into a local store on first run', buttonText: 'Select',  tagText: 'Ready' },
  { key: 'database', title: 'Database Connections', desc: 'Live JDBC / native driver connections',          buttonText: 'Connect', tagText: 'Installed' },
  { key: 'storage',  title: 'Cloud Storage',        desc: 'Object stores and personal drives',              buttonText: 'Connect', tagText: 'Installed' },
  { key: 'api',      title: 'API Connectors',       desc: 'OAuth & token-based service APIs',               buttonText: 'Connect', tagText: 'Installed' },
  { key: 'vector',   title: 'Vector Databases',     desc: 'Embedding stores for AI workflows',              buttonText: 'Connect', tagText: 'Installed' },
];

const NO_PLUGIN_REQUIRED = ['spreadsheet', 'json', 'sqlite', 'nedb', 'lancedb', 'parquet', 'avro', 'generic'];

// Plugin connectors require a (free) Ternlux account; local file connectors stay open.
const LoginLockIcon = ({ color = '#d97706', size = 12 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2">
    <rect x="3" y="11" width="18" height="11" rx="2" />
    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
  </svg>
);

// Inject hover/focus styles — inline styles can't express :hover.
const STYLE_TAG_ID = 'cts-design-styles';
const ensureStyles = () => {
  if (typeof document === 'undefined') return;
  let tag = document.getElementById(STYLE_TAG_ID);
  if (!tag) {
    tag = document.createElement('style');
    tag.id = STYLE_TAG_ID;
    document.head.appendChild(tag);
  }
  tag.innerHTML = `
    .cts-card { background: #fff; transition: background 0.15s; }
    .cts-card.cts-clickable:hover { background: ${C.surface}; }
    .cts-card.cts-disabled { cursor: default; opacity: 0.85; }
    .cts-card .cts-ico { transition: border-color 0.12s; }
    .cts-card.cts-clickable:hover .cts-ico { border-color: ${C.border2}; }

    .cts-tab { transition: color 0.12s, border-color 0.12s; }
    .cts-tab:hover { color: ${C.text}; }
    .cts-pill { transition: all 0.12s; }
    .cts-pill:hover { color: ${C.text}; }

    .cts-search:focus-within { border-color: ${C.accent} !important; box-shadow: 0 0 0 3px ${C.aD}; }

    .cts-btn { transition: all 0.12s; }
    .cts-btn:hover { border-color: ${C.text}; color: ${C.text}; }
    .cts-btn.cts-primary:hover { background: #1d4ed8 !important; border-color: #1d4ed8 !important; }

    .cts-skill { transition: border-color 0.12s, box-shadow 0.12s; }
    .cts-skill:hover { border-color: ${C.violet}; box-shadow: 0 4px 14px rgba(124,58,237,0.08); }

    @keyframes cts-blink { 0%, 80%, 100% { opacity: 0.2; } 40% { opacity: 1; } }
    .cts-dots span {
      display: inline-block; width: 3px; height: 3px; border-radius: 50%;
      background: currentColor; margin: 0 1px; animation: cts-blink 1.2s infinite;
    }
    .cts-dots span:nth-child(2) { animation-delay: 0.18s; }
    .cts-dots span:nth-child(3) { animation-delay: 0.36s; }
  `;
};

// Visual primitives ---------------------------------------------------------

const Icon = ({ c }) => {
  const [errored, setErrored] = useState(false);
  const showImg = c.img && !errored;
  const letters = c.letters || c.title.slice(0, 2).toUpperCase();
  return (
    <div className="cts-ico" style={{
      width: 44, height: 44, borderRadius: 6,
      background: C.surface, border: `1px solid ${C.border}`,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      overflow: 'hidden', flexShrink: 0, marginTop: 2,
    }}>
      {showImg ? (
        <img
          src={c.img}
          alt={c.title}
          style={{ width: 28, height: 28, objectFit: 'contain' }}
          onError={() => setErrored(true)}
        />
      ) : (
        <span style={{
          fontFamily: MONO, fontSize: 11, fontWeight: 700,
          letterSpacing: '0.04em', color: c.tone || C.muted,
        }}>{letters}</span>
      )}
    </div>
  );
};

const StatusTag = ({ c, installing, installed, locked }) => {
  const base = {
    display: 'inline-flex', alignItems: 'center', gap: 4,
    fontFamily: MONO, fontSize: 9.5, fontWeight: 600,
    letterSpacing: '0.06em', textTransform: 'uppercase',
    padding: '2px 6px', borderRadius: 3, lineHeight: 1.5, flexShrink: 0,
  };
  const dot = (color) => (
    <span style={{ width: 5, height: 5, borderRadius: '50%', background: color }} />
  );

  if (locked) {
    return (
      <span style={{ ...base, color: C.amber, background: 'rgba(217,119,6,0.08)', border: '1px solid rgba(217,119,6,0.25)' }}>
        <LoginLockIcon color={C.amber} size={10} /> Login to access
      </span>
    );
  }
  if (installing) {
    return (
      <span style={{ ...base, color: C.violet, background: 'rgba(124,58,237,0.08)', border: '1px solid rgba(124,58,237,0.22)' }}>
        <span className="cts-dots" style={{ display: 'inline-flex' }}>
          <span /><span /><span />
        </span>
        Installing
      </span>
    );
  }
  if (c.fileBased) {
    return (
      <span style={{ ...base, color: C.green, background: 'rgba(5,150,105,0.08)', border: '1px solid rgba(5,150,105,0.22)' }}>
        {dot(C.green)} Ready
      </span>
    );
  }
  if (installed) {
    return (
      <span style={{ ...base, color: C.accent, background: 'rgba(37,99,235,0.08)', border: '1px solid rgba(37,99,235,0.22)' }}>
        {dot(C.accent)} Installed
      </span>
    );
  }
  return (
    <span style={{ ...base, color: C.amber, background: 'rgba(217,119,6,0.08)', border: '1px solid rgba(217,119,6,0.25)' }}>
      Plugin Required
    </span>
  );
};

const ActionBtn = ({ kind, label, onClick, disabled }) => {
  const isPrimary = kind === 'primary';
  const isInstalling = kind === 'installing';
  const style = {
    border: `1px solid ${isPrimary ? C.accent : C.border2}`,
    background: isPrimary ? C.accent : '#fff',
    color: isPrimary ? '#fff' : isInstalling ? C.violet : C.muted,
    fontFamily: SANS, fontSize: 11.5, fontWeight: isPrimary ? 600 : 500,
    padding: '5px 10px', borderRadius: 4,
    cursor: disabled ? 'progress' : 'pointer',
    display: 'inline-flex', alignItems: 'center', gap: 5,
    ...(isInstalling ? { borderColor: 'rgba(124,58,237,0.35)' } : {}),
  };
  const className = `cts-btn${isPrimary ? ' cts-primary' : ''}`;
  return (
    <button type="button" className={className} style={style} disabled={disabled}
      onClick={(e) => { e.stopPropagation(); onClick?.(e); }}>
      {label}
    </button>
  );
};

// Main component ------------------------------------------------------------

const ConnectionTypeSelector = ({ open, onClose, onSelectType }) => {
  const [installedPlugins, setInstalledPlugins] = useState([]);
  const [installedSkills, setInstalledSkills] = useState([]);
  const [loading, setLoading] = useState(true);
  const [installing, setInstalling] = useState({});
  const [activeTab, setActiveTab] = useState('connectors');
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all'); // all | installed | available
  const [loggedIn, setLoggedIn] = useState(isLoggedIn());
  const searchRef = useRef(null);

  useEffect(() => { ensureStyles(); }, []);

  useEffect(() => {
    if (open) {
      loadInstalledPlugins();
      loadInstalledSkills();
      setLoggedIn(isLoggedIn());
      setSearch('');
      setFilter('all');
      setActiveTab('connectors');
    }
  }, [open]);

  // ⌘K / Ctrl+K focuses the search field while the modal is open.
  useEffect(() => {
    if (!open) return;
    const handler = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open]);

  const loadInstalledPlugins = async () => {
    setLoading(true);
    try {
      if (window.electronAPI?.plugins?.listInstalled) {
        const result = await window.electronAPI.plugins.listInstalled();
        if (result.success) {
          setInstalledPlugins(result.connectors || []);
        }
      }
    } catch (error) {
      console.error('Failed to load installed plugins:', error);
    } finally {
      setLoading(false);
    }
  };

  const loadInstalledSkills = async () => {
    try {
      if (window.electronAPI?.skills?.listInstalled) {
        const result = await window.electronAPI.skills.listInstalled();
        if (result.success) {
          setInstalledSkills(result.skills || []);
        }
      }
    } catch (error) {
      console.error('Failed to load installed skills:', error);
    }
  };

  const isPluginInstalled = (key) => {
    if (NO_PLUGIN_REQUIRED.includes(key)) return true;
    return installedPlugins.some((p) => p.id === key);
  };

  // Plugin connectors are locked behind a (free) account; local file
  // connectors never require login.
  const isLocked = (key) => !NO_PLUGIN_REQUIRED.includes(key) && !loggedIn;

  // Close the selector and send the user to Settings → Account to sign in.
  const handleLockedClick = (type) => {
    message.info(`Sign in to access the ${type.title} plugin.`);
    onClose();
    window.dispatchEvent(new CustomEvent('ternlux:open-settings', { detail: { tab: 'account' } }));
  };

  const handleInstallPlugin = async (type) => {
    if (isLocked(type.key)) {
      handleLockedClick(type);
      return;
    }
    setInstalling((prev) => ({ ...prev, [type.key]: true }));
    try {
      if (!window.electronAPI?.plugins?.install) {
        message.error('Plugin installation not available');
        return;
      }
      const result = await window.electronAPI.plugins.install(type.key);
      if (result.success) {
        message.success(`${type.title} connector installed successfully!`);
        await loadInstalledPlugins();
      } else {
        message.error(`Failed to install: ${result.message}`);
      }
    } catch (error) {
      console.error('Installation error:', error);
      message.error('Failed to install plugin');
    } finally {
      setInstalling((prev) => ({ ...prev, [type.key]: false }));
    }
  };

  const handleSelect = (type) => {
    if (isLocked(type.key)) {
      handleLockedClick(type);
      return;
    }
    if (!isPluginInstalled(type.key)) {
      message.warning(`Please install the ${type.title} connector first`);
      return;
    }
    onSelectType(type.key);
    onClose();
  };

  const filteredConnectors = useMemo(() => {
    const q = search.trim().toLowerCase();
    return CONNECTION_TYPES.filter((c) => {
      const matchesQ = !q
        || c.title.toLowerCase().includes(q)
        || c.description.toLowerCase().includes(q)
        || c.key.toLowerCase().includes(q);
      if (!matchesQ) return false;
      const installed = isPluginInstalled(c.key);
      if (filter === 'installed') return installed;
      if (filter === 'available') return !installed;
      return true;
    });
  }, [search, filter, installedPlugins]);

  // Card ---------------------------------------------------------------------
  const renderCard = (c, section) => {
    const locked = isLocked(c.key);
    const installed = isPluginInstalled(c.key);
    const isInstalling = !!installing[c.key];
    const selectable = !locked && installed && !isInstalling;
    return (
      <div
        key={c.key}
        className={`cts-card ${selectable ? 'cts-clickable' : 'cts-disabled'}`}
        style={{
          padding: '16px 18px',
          cursor: selectable ? 'pointer' : 'default',
          display: 'grid',
          gridTemplateColumns: '44px 1fr auto',
          gap: 14,
          alignItems: 'flex-start',
          minHeight: 80,
          ...(locked ? { opacity: 0.65 } : {}),
        }}
        onClick={() => (locked ? handleLockedClick(c) : selectable && handleSelect(c))}
      >
        <div style={{ position: 'relative' }}>
          <Icon c={c} />
          {locked && (
            <div style={{
              position: 'absolute', right: -5, bottom: -3,
              width: 18, height: 18, borderRadius: '50%',
              background: '#fff', border: `1px solid ${C.border2}`,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <LoginLockIcon color={C.amber} size={10} />
            </div>
          )}
        </div>
        <div style={{ minWidth: 0, paddingTop: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 5, flexWrap: 'wrap' }}>
            <span style={{
              fontSize: 13.5, fontWeight: 600,
              color: selectable ? C.text : C.muted,
              letterSpacing: '-0.01em',
            }}>{c.title}</span>
            <StatusTag c={c} installing={isInstalling} installed={installed} locked={locked} />
          </div>
          <div style={{
            fontSize: 12, color: C.muted, lineHeight: 1.5,
            display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
          }}>{c.description}</div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0, marginTop: 2 }}>
          {locked ? (
            <ActionBtn kind="ghost" label="Login to access" onClick={() => handleLockedClick(c)} />
          ) : isInstalling ? (
            <ActionBtn kind="installing" label="Installing" disabled />
          ) : installed ? (
            <ActionBtn kind="primary" label={section.buttonText} onClick={() => handleSelect(c)} />
          ) : (
            <ActionBtn kind="ghost" label="Install" onClick={() => handleInstallPlugin(c)} />
          )}
        </div>
      </div>
    );
  };

  // Tabs ---------------------------------------------------------------------
  const Tab = ({ id, iconName, label, count }) => {
    const active = activeTab === id;
    return (
      <button
        type="button"
        className="cts-tab"
        onClick={() => setActiveTab(id)}
        style={{
          border: 'none', background: 'none', cursor: 'pointer',
          padding: '11px 14px',
          fontFamily: SANS, fontSize: 13, fontWeight: active ? 600 : 500,
          color: active ? C.accent : C.muted,
          display: 'flex', alignItems: 'center', gap: 8,
          borderBottom: `2px solid ${active ? C.accent : 'transparent'}`,
          marginBottom: -1,
        }}
      >
        {I(iconName, active ? C.accent : C.muted, 13)}
        {label}
        <span style={{
          fontFamily: MONO, fontSize: 10,
          background: active ? C.aD : C.s2, color: active ? C.accent : C.muted,
          padding: '1px 6px', borderRadius: 8, lineHeight: 1.6,
        }}>{count}</span>
      </button>
    );
  };

  const Pill = ({ id, label }) => {
    const active = filter === id;
    return (
      <button type="button" className="cts-pill" onClick={() => setFilter(id)}
        style={{
          border: 'none', background: active ? C.aD : 'none', cursor: 'pointer',
          fontFamily: SANS, fontSize: 12, fontWeight: active ? 600 : 500,
          color: active ? C.accent : C.muted,
          padding: '5px 10px', borderRadius: 4,
        }}>{label}</button>
    );
  };

  // Connectors pane ----------------------------------------------------------
  const renderConnectorsPane = () => {
    if (loading) {
      return <div style={{ textAlign: 'center', padding: 60 }}><Spin size="large" /></div>;
    }

    const sectionLists = SECTIONS.map((s) => ({
      section: s,
      items: filteredConnectors.filter((c) => c.category === s.key),
    })).filter((s) => s.items.length > 0);

    if (sectionLists.length === 0) {
      return (
        <div style={{ textAlign: 'center', padding: '60px 20px', color: C.muted }}>
          <div style={{
            width: 56, height: 56, margin: '0 auto 14px', borderRadius: 10,
            background: C.surface, border: `1px dashed ${C.border2}`,
            display: 'flex', alignItems: 'center', justifyContent: 'center', color: C.dim,
          }}>{I('compass', C.dim, 24)}</div>
          <h4 style={{ fontSize: 14, fontWeight: 600, color: C.text, marginBottom: 4 }}>No connectors match</h4>
          <p style={{ fontSize: 12.5, lineHeight: 1.6, maxWidth: 320, margin: '0 auto' }}>
            Try a different search term, or clear filters to browse the full registry.
          </p>
        </div>
      );
    }

    return (
      <>
        {sectionLists.map(({ section, items }, idx) => (
          <div key={section.key} style={{ marginTop: idx === 0 ? 0 : 8 }}>
            <div style={{
              display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
              marginBottom: 12, marginTop: 8,
            }}>
              <h3 style={{
                fontFamily: MONO, fontSize: 11, fontWeight: 700,
                letterSpacing: '0.12em', textTransform: 'uppercase', color: C.text,
                display: 'flex', alignItems: 'center', gap: 8, margin: 0,
              }}>
                {section.title}
                <span style={{
                  fontFamily: MONO, fontSize: 10, color: C.dim,
                  padding: '1px 7px', borderRadius: 8, background: C.s2,
                }}>{items.length}</span>
              </h3>
              <span style={{ fontSize: 12, color: C.muted }}>{section.desc}</span>
            </div>
            <div style={{
              display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)',
              gap: 1, background: C.border,
              border: `1px solid ${C.border}`, borderRadius: 8, overflow: 'hidden',
              marginBottom: 22,
            }}>
              {items.map((c) => renderCard(c, section))}
            </div>
          </div>
        ))}
      </>
    );
  };

  // Skills pane --------------------------------------------------------------
  const renderSkillsPane = () => {
    if (loading) {
      return <div style={{ textAlign: 'center', padding: 60 }}><Spin size="large" /></div>;
    }
    const q = search.trim().toLowerCase();
    const items = installedSkills.filter((s) => {
      if (!q) return true;
      const name = (s.metadata?.displayName || s.name || '').toLowerCase();
      const desc = (s.metadata?.description || '').toLowerCase();
      const cat = (s.category || '').toLowerCase();
      return name.includes(q) || desc.includes(q) || cat.includes(q);
    });

    if (items.length === 0) {
      return (
        <div style={{ textAlign: 'center', padding: '60px 20px', color: C.muted }}>
          <div style={{
            width: 56, height: 56, margin: '0 auto 14px', borderRadius: 10,
            background: C.surface, border: `1px dashed ${C.border2}`,
            display: 'flex', alignItems: 'center', justifyContent: 'center', color: C.dim,
          }}>{I('zap', C.dim, 24)}</div>
          <h4 style={{ fontSize: 14, fontWeight: 600, color: C.text, marginBottom: 4 }}>
            {installedSkills.length === 0 ? 'No skills installed yet' : 'No skills match'}
          </h4>
          <p style={{ fontSize: 12.5, lineHeight: 1.6, maxWidth: 320, margin: '0 auto' }}>
            Skills extend transform nodes with reusable logic — they will appear here once installed.
          </p>
        </div>
      );
    }

    return (
      <>
        <div style={{
          display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
          marginBottom: 12,
        }}>
          <h3 style={{
            fontFamily: MONO, fontSize: 11, fontWeight: 700,
            letterSpacing: '0.12em', textTransform: 'uppercase', color: C.text,
            display: 'flex', alignItems: 'center', gap: 8, margin: 0,
          }}>
            Installed Skills
            <span style={{
              fontFamily: MONO, fontSize: 10, color: C.dim,
              padding: '1px 7px', borderRadius: 8, background: C.s2,
            }}>{items.length}</span>
          </h3>
          <span style={{ fontSize: 12, color: C.muted }}>
            Drag a skill onto a transform node to attach it
          </span>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 12 }}>
          {items.map((s) => (
            <div key={s.id} className="cts-skill" style={{
              background: '#fff', border: `1px solid ${C.border}`,
              borderRadius: 8, padding: 16, cursor: 'pointer', position: 'relative',
            }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 10 }}>
                <div style={{
                  width: 36, height: 36, borderRadius: 6,
                  background: 'linear-gradient(135deg, rgba(124,58,237,0.1), rgba(37,99,235,0.08))',
                  border: '1px solid rgba(124,58,237,0.18)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  flexShrink: 0, color: C.violet,
                }}>{I('zap', C.violet, 18)}</div>
                <div>
                  <div style={{ fontSize: 14, fontWeight: 600, color: C.text, marginBottom: 2, letterSpacing: '-0.01em' }}>
                    {s.metadata?.displayName || s.name}
                  </div>
                  <div style={{
                    fontFamily: MONO, fontSize: 10, color: C.violet,
                    letterSpacing: '0.06em', textTransform: 'uppercase',
                  }}>{s.category || 'transformer'}</div>
                </div>
              </div>
              <div style={{ fontSize: 12, color: C.muted, lineHeight: 1.55, marginBottom: 12 }}>
                {s.metadata?.description || 'No description available'}
              </div>
            </div>
          ))}
        </div>
      </>
    );
  };

  // Render -------------------------------------------------------------------
  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      width="calc(100vw - 64px)"
      style={{ top: 40, paddingBottom: 0, maxWidth: 1600 }}
      destroyOnClose
      closable={false}
      title={null}
      styles={{ body: { padding: 0 }, content: { padding: 0, overflow: 'hidden', borderRadius: 10 } }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', maxHeight: 'calc(100vh - 80px)' }}>
        {/* Title */}
        <div style={{
          padding: '22px 28px 18px',
          borderBottom: `1px solid ${C.border}`,
          background: 'linear-gradient(180deg, #ffffff 0%, #fafbfd 100%)',
          position: 'relative',
        }}>
          <div style={{
            fontFamily: MONO, fontSize: 10, fontWeight: 700,
            letterSpacing: '0.14em', textTransform: 'uppercase',
            color: C.accent, marginBottom: 8,
          }}>Add Connector</div>
          <h1 style={{
            fontSize: 20, fontWeight: 700, letterSpacing: '-0.025em',
            color: C.text, marginBottom: 4, margin: 0,
          }}>Plugins &amp; Skills</h1>
          <p style={{ fontSize: 13, color: C.muted, lineHeight: 1.5, marginTop: 4 }}>
            Connect a data source, cloud storage, or attach a transform skill to your workflow.
          </p>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            style={{
              position: 'absolute', top: 16, right: 16,
              width: 28, height: 28, borderRadius: 4,
              border: '1px solid transparent', background: 'transparent',
              cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: C.dim,
            }}
            onMouseOver={(e) => { e.currentTarget.style.background = C.s2; e.currentTarget.style.color = C.text; e.currentTarget.style.borderColor = C.border; }}
            onMouseOut={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = C.dim; e.currentTarget.style.borderColor = 'transparent'; }}
          >{I('x', 'currentColor', 14)}</button>
        </div>

        {/* Tabs */}
        <div style={{
          display: 'flex', padding: '0 28px',
          borderBottom: `1px solid ${C.border}`, background: '#fff', flexShrink: 0,
        }}>
          <Tab id="connectors" iconName="db" label="Connectors" count={CONNECTION_TYPES.length} />
          <Tab id="skills" iconName="zap" label="Skills" count={installedSkills.length} />
        </div>

        {/* Toolbar */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 12,
          padding: '14px 28px',
          borderBottom: `1px solid ${C.border}`,
          background: C.surface, flexShrink: 0,
        }}>
          <div className="cts-search" style={{
            flex: 1, position: 'relative',
            display: 'flex', alignItems: 'center', gap: 8,
            background: '#fff', border: `1px solid ${C.border}`,
            borderRadius: 6, padding: '7px 12px',
          }}>
            {I('compass', C.dim, 14)}
            <input
              ref={searchRef}
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={activeTab === 'connectors' ? 'Search connectors, formats, or providers…' : 'Search skills…'}
              autoComplete="off"
              style={{
                flex: 1, border: 'none', outline: 'none', background: 'transparent',
                fontFamily: SANS, fontSize: 13, color: C.text,
              }}
            />
            <span style={{
              fontFamily: MONO, fontSize: 10, color: C.dim,
              border: `1px solid ${C.border}`, padding: '1px 6px',
              borderRadius: 3, background: C.surface,
            }}>⌘K</span>
          </div>
          {activeTab === 'connectors' && (
            <div style={{
              display: 'flex', gap: 4,
              background: '#fff', border: `1px solid ${C.border}`,
              padding: 3, borderRadius: 6,
            }}>
              <Pill id="all" label="All" />
              <Pill id="installed" label="Installed" />
            </div>
          )}
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '22px 28px 24px' }}>
          {activeTab === 'connectors' ? renderConnectorsPane() : renderSkillsPane()}
        </div>
      </div>
    </Modal>
  );
};

export default ConnectionTypeSelector;
