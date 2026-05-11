import React, { useState, useEffect } from 'react';
import { Modal, message, Space } from 'antd';
import { CompassOutlined } from '@ant-design/icons';
import axios from 'axios';

import DataPreviewModal from './DataPreviewModal';
import DataSourceUpload from './DataSourceUpload';
import ConnectionTypeSelector from './ConnectionTypeSelector';

import DynamicConnectionForm from './connections/DynamicConnectionForm';
import LocalFileConnectionForm from './connections/LocalFileConnectionForm';

import DatabaseExplorer from '../DatabaseExplorer/DatabaseExplorer';

import { connectionsDb } from '../../utils/localDb';
import { C, MONO, I, Btn, Tag, MoreMenu, PageHeader } from './_designShared';

// Subtype color/label config — used for the bottom-of-card chip
const CONN_TYPE_CFG = {
  postgres: { label: 'PostgreSQL', color: C.accent,  bg: C.aD,                    border: 'rgba(37,99,235,0.18)' },
  mysql:    { label: 'MySQL',      color: C.amber,   bg: C.amD,                   border: 'rgba(217,119,6,0.18)' },
  mssql:    { label: 'SQL Server', color: '#0078d4', bg: 'rgba(0,120,212,0.07)',  border: 'rgba(0,120,212,0.2)' },
  mongodb:  { label: 'MongoDB',    color: C.green,   bg: C.gD,                    border: 'rgba(5,150,105,0.18)' },
  csv:      { label: 'CSV',        color: C.amber,   bg: C.amD,                   border: 'rgba(217,119,6,0.18)' },
  excel:    { label: 'Excel',      color: C.cyan,    bg: C.cD,                    border: 'rgba(8,145,178,0.18)' },
  sqlite:   { label: 'SQLite',     color: C.cyan,    bg: C.cD,                    border: 'rgba(8,145,178,0.18)' },
  nedb:     { label: 'NeDB',       color: C.green,   bg: C.gD,                    border: 'rgba(5,150,105,0.18)' },
  parquet:  { label: 'Parquet',    color: C.violet,  bg: C.vD,                    border: 'rgba(124,58,237,0.18)' },
  avro:     { label: 'Avro',       color: '#db2777', bg: 'rgba(219,39,119,0.06)', border: 'rgba(219,39,119,0.18)' },
  json:     { label: 'JSON',       color: C.amber,   bg: C.amD,                   border: 'rgba(217,119,6,0.18)' },
  lancedb:  { label: 'LanceDB',    color: C.violet,  bg: C.vD,                    border: 'rgba(124,58,237,0.18)' },
  spreadsheet: { label: 'Spreadsheet', color: C.accent, bg: C.aD,                 border: 'rgba(37,99,235,0.18)' },
  shopify:  { label: 'Shopify',    color: C.green,   bg: C.gD,                    border: 'rgba(5,150,105,0.18)' },
  clover_pos: { label: 'Clover POS', color: C.green, bg: C.gD,                    border: 'rgba(5,150,105,0.18)' },
  square_pos: { label: 'Square POS', color: C.violet, bg: C.vD,                   border: 'rgba(124,58,237,0.18)' },
};

const subTypeOf = (conn) =>
  conn.dbType || conn.fileType || conn.apiType || conn.connectionType || 'file';

// Plugin dbCategory values that have no useful Explore/Preview action.
const NO_MIDDLE_ACTION_CATEGORIES = new Set(['Vector', 'CloudStorage', 'API']);

const ConnIcon = ({ conn }) => {
  const isFile = conn.connectionType === 'file';
  const isDb   = conn.connectionType === 'database';
  const isApi  = conn.connectionType === 'api';
  const color  = isDb ? C.accent : isApi ? C.green : C.cyan;
  const bg     = isDb ? C.aD : isApi ? C.gD : C.cD;
  const border = isDb ? 'rgba(37,99,235,0.2)'
    : isApi ? 'rgba(5,150,105,0.2)'
    : 'rgba(8,145,178,0.2)';
  const iconName = isFile ? 'file' : 'db';
  return (
    <div style={{
      width: 32, height: 32, borderRadius: 5, flexShrink: 0,
      background: bg, border: `1px solid ${border}`,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      {I(iconName, color, 15)}
    </div>
  );
};

const formatDate = (d) => {
  if (!d) return '';
  try { return new Date(d).toLocaleDateString(); } catch { return ''; }
};

const ConnectionCard = ({ conn, plugin, onEdit, onPreview, onExplore, onDelete }) => {
  const [hov, setHov] = useState(false);
  const subType = subTypeOf(conn);
  const tc = CONN_TYPE_CFG[subType] || { label: subType, color: C.muted, bg: C.s2, border: C.border };
  const fileSizeMB = conn.fileInfo?.fileSize ? (conn.fileInfo.fileSize / 1024 / 1024).toFixed(2) : null;
  const dbCategory = conn.dbCategory || plugin?.dbCategory;
  const hideMiddleAction = NO_MIDDLE_ACTION_CATEGORIES.has(dbCategory);
  const middleAction = hideMiddleAction
    ? []
    : conn.connectionType === 'database'
      ? [{ label: 'Explore DB', icon: 'compass', onClick: () => onExplore(conn) }]
      : [{ label: 'Preview Data', icon: 'eye', onClick: () => onPreview(conn) }];

  return (
    <div
      onMouseOver={() => setHov(true)} onMouseOut={() => setHov(false)}
      style={{
        background: '#fff', border: `1px solid ${hov ? C.border2 : C.border}`,
        borderRadius: 6, overflow: 'hidden',
        transition: 'all 0.15s',
        boxShadow: hov ? '0 4px 16px rgba(0,0,0,0.07)' : '0 1px 3px rgba(0,0,0,0.04)',
        display: 'flex', flexDirection: 'column',
      }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px',
        borderBottom: `1px solid ${C.border}`,
      }}>
        <ConnIcon conn={conn} />
        <span title={conn.name} style={{
          fontSize: 13, fontWeight: 600, color: C.text, letterSpacing: '-0.02em',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1,
        }}>
          {conn.name || conn.connectionName || 'Unnamed connection'}
        </span>
        <MoreMenu items={[
          { label: 'Edit', icon: 'edit', onClick: () => onEdit(conn) },
          ...middleAction,
          { label: 'Delete', icon: 'trash', danger: true, onClick: () => onDelete(conn) },
        ]} />
      </div>
      <div style={{ padding: '12px 14px', flex: 1, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{
          fontSize: 12, color: C.muted, lineHeight: 1.55,
          display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
          minHeight: 36,
        }}>
          {conn.description || <span style={{ color: C.dim, fontStyle: 'italic' }}>No description</span>}
        </div>
        <div style={{ fontSize: 11, color: C.muted, fontFamily: MONO, lineHeight: 1.8 }}>
          {conn.connectionType === 'database' && conn.dbConfig?.host && (
            <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              host: {conn.dbConfig.host}{conn.dbConfig.port ? `:${conn.dbConfig.port}` : ''}
            </div>
          )}
          {conn.dbConfig?.database && <div>db: {conn.dbConfig.database}</div>}
          {conn.dbConfig?.engine && <div>engine: {conn.dbConfig.engine}</div>}
          {conn.fileInfo?.originalName && (
            <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              file: {conn.fileInfo.originalName}
            </div>
          )}
          {fileSizeMB && <div>size: {fileSizeMB} MB</div>}
          {conn.apiType && <div>via: REST API</div>}
        </div>
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          marginTop: 'auto', paddingTop: 4,
        }}>
          <Tag color={tc.color} bg={tc.bg} border={tc.border}>{tc.label}</Tag>
          {conn.createdAt && (
            <span style={{ fontSize: 11, color: C.dim, fontFamily: MONO }}>
              {formatDate(conn.createdAt)}
            </span>
          )}
        </div>
      </div>
    </div>
  );
};

const ConnectionsTab = ({ onContextChange = () => {} }) => {
  const [connections, setConnections] = useState([]);
  const [isConnectionTypeSelectorOpen, setTypeSelectorOpen] = useState(false);
  const [isUploadModalOpen, setUploadModalOpen] = useState(false);
  const [activeDbType, setActiveDbType] = useState(null);
  const [editingConnection, setEditingConnection] = useState(null);
  const [editingSchema, setEditingSchema] = useState(null);
  const [previewData, setPreviewData] = useState(null);
  const [isPreviewOpen, setPreviewOpen] = useState(false);
  const [explorerConnection, setExplorerConnection] = useState(null);
  const [installedPlugins, setInstalledPlugins] = useState([]);
  const [pluginsLoaded, setPluginsLoaded] = useState(false);

  useEffect(() => {
    fetchConnections();
    loadInstalledPlugins();
  }, []);

  const loadInstalledPlugins = async () => {
    try {
      if (window.electronAPI?.plugins?.listInstalled) {
        const result = await window.electronAPI.plugins.listInstalled();
        if (result.success) setInstalledPlugins(result.connectors || []);
      }
    } catch (error) {
      console.error('Failed to load installed plugins:', error);
    } finally {
      setPluginsLoaded(true);
    }
  };

  const isLoggedIn = () => Boolean(localStorage.getItem('auth-token'));

  const handleAuthError = (error) => {
    if ([400, 401, 204].includes(error.response?.status)) {
      localStorage.removeItem('auth-token');
      message.error('Session expired. Please log in again.');
      window.location.href = '/login';
      return true;
    }
    return false;
  };

  const fetchConnections = async () => {
    if (!isLoggedIn()) {
      const local = await connectionsDb.getAll();
      setConnections(local);
      return;
    }
    try {
      const response = await axios.post('/workflow/connections', { transformer: false }, {
        headers: { 'auth-token': localStorage.getItem('auth-token') },
      });
      if (response.data.success) setConnections(response.data.data);
    } catch (error) {
      if (handleAuthError(error)) return;
      console.error('Error fetching connections:', error);
      message.error('Failed to load connections');
    }
  };

  const handleConnectionTypeSelect = (type) => {
    setEditingConnection(null);
    setActiveDbType(type);
  };

  const handleTestConnection = async (dbType, config) => {
    let result;
    if (window.electronAPI?.dbConnect) {
      result = await window.electronAPI.dbConnect.test(dbType, config);
    } else if (!isLoggedIn()) {
      result = { success: false, message: 'Sign in or use the desktop app to test live database connections.' };
    } else {
      try {
        const response = await axios.post('/workflow/test-connection', { dbType, config }, {
          headers: { 'auth-token': localStorage.getItem('auth-token') },
        });
        result = response.data.success
          ? { success: true,  message: response.data.message || 'Connection successful!' }
          : { success: false, message: response.data.error   || 'Connection failed.' };
      } catch (err) {
        result = { success: false, message: err.response?.data?.error || 'Connection failed. Check your credentials.' };
      }
    }

    if (result.success) message.success(result.message || 'Connection successful!');
    else message.error(result.message || 'Connection failed.');
    return result;
  };

  const handleSaveDbConnection = async (connectionData) => {
    const connectionId = editingConnection?.id || editingConnection?._id;
    const isEditing = Boolean(connectionId);
    const isFileConnection = connectionData.connectionType === 'file';

    if (!isLoggedIn() || isFileConnection) {
      try {
        if (connectionData.connectionType === 'database' && connectionData.dbConfig && window.electronAPI?.dbCredentials) {
          const { dbConfig, ...connectionDataWithoutConfig } = connectionData;
          let sensitiveFields = {};
          let nonSensitiveConfig = {};
          const plugin = installedPlugins.find(p => p.id === connectionData.dbType);
          if (plugin && plugin.configSchema && plugin.configSchema.fields) {
            plugin.configSchema.fields.forEach(field => {
              const fieldValue = dbConfig[field.name];
              if (fieldValue !== undefined) {
                if (field.sensitive) sensitiveFields[field.name] = fieldValue;
                else nonSensitiveConfig[field.name] = fieldValue;
              }
            });
          } else {
            sensitiveFields = {
              password: dbConfig.password, username: dbConfig.username,
              host: dbConfig.host, uri: dbConfig.uri,
            };
            nonSensitiveConfig = {
              port: dbConfig.port, database: dbConfig.database, ssl: dbConfig.ssl,
              instanceName: dbConfig.instanceName, engine: dbConfig.engine, schema: dbConfig.schema,
            };
          }
          const safeConnectionData = { ...connectionDataWithoutConfig, dbConfig: nonSensitiveConfig };
          if (isEditing) {
            await connectionsDb.update(connectionId, safeConnectionData);
            await window.electronAPI.dbCredentials.update(connectionId, sensitiveFields, connectionData.dbType);
            setConnections(prev => prev.map(c =>
              (c.id || c._id) === connectionId ? { ...c, ...safeConnectionData } : c));
            message.success('Connection updated securely.');
          } else {
            const saved = await connectionsDb.save(safeConnectionData);
            await window.electronAPI.dbCredentials.save(saved.id, sensitiveFields);
            setConnections(prev => [saved, ...prev]);
            message.success('Connection saved securely.');
          }
        } else {
          if (isEditing) {
            await connectionsDb.update(connectionId, connectionData);
            setConnections(prev => prev.map(c =>
              (c.id || c._id) === connectionId ? { ...c, ...connectionData } : c));
            message.success('Connection updated.');
          } else {
            const saved = await connectionsDb.save(connectionData);
            setConnections(prev => [saved, ...prev]);
            message.success('Connection saved.');
          }
        }
        setActiveDbType(null);
        setEditingConnection(null);
      } catch (error) {
        console.error('Error saving connection:', error);
        message.error(`Failed to ${isEditing ? 'update' : 'save'} connection.`);
      }
      return;
    }

    try {
      const payload = isEditing
        ? { ...connectionData, status: 'untested', connectionId }
        : { ...connectionData, status: 'untested' };
      const endpoint = isEditing ? '/workflow/connection-update' : '/workflow/connection-save';
      const response = await axios.post(endpoint, payload, {
        headers: { 'auth-token': localStorage.getItem('auth-token') },
      });
      if (response.data.success) {
        await fetchConnections();
        setActiveDbType(null);
        setEditingConnection(null);
        message.success(isEditing ? 'Connection updated.' : 'Connection saved.');
      } else {
        message.error(response.data.error || `Failed to ${isEditing ? 'update' : 'save'} connection.`);
      }
    } catch (err) {
      if (handleAuthError(err)) return;
      message.error(`Failed to ${isEditing ? 'update' : 'save'} connection.`);
    }
  };

  const handleEditConnection = (connection) => {
    setEditingConnection(connection);
    onContextChange({
      kind: 'connection',
      id: connection.id || connection._id,
      name: connection.name,
      summary: `${connection.dbType || 'unknown'} · ${connection.connectionType || ''}`.trim(),
    });
    if (connection.connectionType === 'database') {
      setActiveDbType(connection.dbType);
    } else if (connection.connectionType === 'file') {
      const fileType = connection.dbType || connection.fileType;
      if (['sqlite', 'nedb', 'json', 'parquet', 'avro', 'lancedb'].includes(fileType)) {
        setActiveDbType(fileType);
      } else {
        setActiveDbType('spreadsheet');
        setUploadModalOpen(true);
      }
    } else {
      setActiveDbType('spreadsheet');
      setUploadModalOpen(true);
    }
  };

  const handleDeleteConnection = (connection) => {
    Modal.confirm({
      title: 'Delete Connection',
      content: 'Are you sure? This cannot be undone.',
      okText: 'Delete', okType: 'danger', cancelText: 'Cancel',
      async onOk() {
        const connectionId = connection.id || connection._id;
        if (!isLoggedIn()) {
          await connectionsDb.delete(connectionId);
          if (connection.connectionType === 'database' && window.electronAPI?.dbCredentials) {
            await window.electronAPI.dbCredentials.delete(connectionId);
          }
          setConnections(prev => prev.filter(c => (c.id || c._id) !== connectionId));
          message.success('Connection deleted.');
          return;
        }
        try {
          const response = await axios.post('/workflow/connection-action',
            { action: 'delete', connectionId },
            { headers: { 'Content-Type': 'application/json', 'auth-token': localStorage.getItem('auth-token') } });
          if (response.data.success) {
            setConnections(prev => prev.filter(c => c._id !== connectionId));
            message.success('Connection deleted.');
          } else {
            message.error(response.data.error || 'Failed to delete.');
          }
        } catch (error) {
          if (handleAuthError(error)) return;
          message.error('Failed to delete connection.');
        }
      },
    });
  };

  const handleUploadComplete = () => {
    fetchConnections();
    setUploadModalOpen(false);
    setEditingConnection(null);
    message.success(editingConnection ? 'Data source updated.' : 'Data source created.');
  };

  const handlePreviewData = async (connection) => {
    onContextChange({
      kind: 'connection',
      id: connection.id || connection._id,
      name: connection.name,
      summary: `${connection.dbType || 'unknown'} · ${connection.connectionType || ''}`.trim(),
    });
    if (connection.connectionType === 'file') {
      if (connection.dbType === 'sqlite' || connection.dbType === 'nedb' || connection.dbType === 'lancedb') {
        const filePath = connection.fileInfo?.filePath;
        if (!filePath) { message.error('File path not found'); return; }
        if (!window.electronAPI?.db?.readLocalCollection) {
          message.warning('Local database preview requires the desktop app.');
          return;
        }
        const hide = message.loading('Reading local database…', 0);
        try {
          const storageType = connection.dbType;
          const result = await window.electronAPI.db.readLocalCollection(filePath, 1000, storageType, null, null);
          hide();
          if (!result.success) { message.error('Failed to read database: ' + result.message); return; }
          const rows = result.rows || [];
          const cols = rows.length > 0 ? Object.keys(rows[0]) : [];
          setPreviewData({
            connection,
            data: rows.map((r, i) => ({ ...r, _sampleIndex: i + 1 })),
            columns: cols,
            metadata: {
              totalRows: rows.length, dbType: connection.dbType,
              tables: result.tables || [], currentTable: result.currentTable,
            },
          });
          setPreviewOpen(true);
        } catch (err) { hide(); message.error('Failed to read database: ' + err.message); }
        return;
      }

      if (!window.electronAPI?.fileReader) {
        message.warning('Local file preview requires the desktop app.');
        return;
      }

      let filePath = connection.fileInfo?.filePath;
      if (!filePath) {
        const dialogResult = await window.electronAPI.openFileDialog();
        if (dialogResult.canceled || !dialogResult.filePaths?.length) return;
        filePath = dialogResult.filePaths[0];
      }

      const hide = message.loading('Reading local file…', 0);
      try {
        const result = await window.electronAPI.fileReader.readRows(filePath, 1000);
        hide();
        if (!result.success) { message.error('Failed to read file: ' + result.message); return; }
        const sheetName = result.sheets[0];
        const sheetData = result.data[sheetName];
        const rows = sheetData.rows.map((r, i) => ({ ...r, _sampleIndex: i + 1 }));
        const cols = sheetData.columns;
        setPreviewData({
          connection, data: rows, columns: cols,
          metadata: { sheets: result.sheets, activeSheet: sheetName, totalRows: rows.length },
        });
        setPreviewOpen(true);
      } catch (err) { hide(); message.error('Failed to read file: ' + err.message); }
      return;
    }

    try {
      message.loading('Loading sample data...', 2);
      const headers = { 'Content-Type': 'application/json', 'auth-token': localStorage.getItem('auth-token') };
      const response = await axios.post('/workflow/sample-data', { connectionId: connection.id, limit: 1000 }, { headers });
      if (response.data.success) {
        const sd = response.data.data;
        if (sd.availableSheets && sd.message) {
          const sr = await axios.post('/workflow/sample-data',
            { connectionId: connection.id, limit: 1000, sheetName: sd.availableSheets[0].sheetName }, { headers });
          if (sr.data.success) {
            const shd = sr.data.data;
            const rows = shd.sampleRows.map((r, i) => ({ ...r.data, _rowIndex: r.rowIndex, _sampleIndex: i + 1 }));
            const cols = shd.columnMappings?.map(c => c.name) || Object.keys(rows[0] || {}).filter(k => !k.startsWith('_'));
            setPreviewData({ connection, data: rows, columns: cols, metadata: { ...shd, availableSheets: sd.availableSheets } });
            setPreviewOpen(true);
            message.destroy();
            return;
          }
        }
        if (sd.sampleRows) {
          const rows = sd.sampleRows.map((r, i) => ({ ...r.data, _rowIndex: r.rowIndex, _sampleIndex: i + 1 }));
          const cols = sd.columnMappings?.map(c => c.name) || Object.keys(rows[0] || {}).filter(k => !k.startsWith('_'));
          setPreviewData({ connection, data: rows, columns: cols, metadata: sd });
          setPreviewOpen(true);
        } else {
          message.error('No sample data available.');
        }
      } else {
        message.error(response.data.error || 'Failed to load sample data.');
      }
      message.destroy();
    } catch (error) {
      if (handleAuthError(error)) return;
      message.error('Failed to load sample data.');
    }
  };

  const getModalTitle = (dbType) => {
    const titleMap = {
      sqlite: 'Connect SQLite Database',
      nedb: 'Connect NeDB Database',
      lancedb: 'Connect LanceDB Vector Database',
      json: 'Upload JSON File',
      spreadsheet: 'Add Spreadsheet',
      parquet: 'Upload Parquet File',
      avro: 'Upload Avro File',
    };
    if (titleMap[dbType]) return titleMap[dbType];
    const plugin = installedPlugins.find(p => p.id === dbType);
    if (plugin) return `Connect to ${plugin.metadata?.displayName || plugin.name}`;
    return 'Connect to Database';
  };

  const getActiveFormComponent = () => {
    if (!activeDbType) return null;
    if (['sqlite', 'nedb', 'lancedb', 'json', 'spreadsheet', 'parquet', 'avro'].includes(activeDbType)) {
      return () => (
        <LocalFileConnectionForm
          fileType={activeDbType}
          onSave={handleSaveDbConnection}
          onCancel={() => { setActiveDbType(null); setEditingConnection(null); }}
          editingConnection={editingConnection}
        />
      );
    }
    const plugin = installedPlugins.find(p => p.id === activeDbType);
    if (plugin) {
      return () => (
        <DynamicConnectionForm
          plugin={plugin}
          onSave={handleSaveDbConnection}
          onCancel={() => { setActiveDbType(null); setEditingConnection(null); }}
          onTest={handleTestConnection}
          editingConnection={editingConnection}
        />
      );
    }
    return null;
  };

  const ActiveForm = getActiveFormComponent();

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden', background: C.surface }}>
      <PageHeader
        title="Data Source Connections"
        sub="Manage spreadsheet uploads and database connections"
        actions={[
          <Btn key="new" variant="primary" icon="plus" onClick={() => setTypeSelectorOpen(true)}>
            New Connection
          </Btn>,
        ]}
      />

      <div style={{ flex: 1, overflow: 'auto', padding: 24 }}>
        {connections.length === 0 ? (
          <div style={{
            textAlign: 'center', padding: '60px 24px', background: '#fff',
            border: `1px dashed ${C.border2}`, borderRadius: 6, color: C.muted,
          }}>
            <div style={{ marginBottom: 8 }}>{I('db', C.dim, 32)}</div>
            <div style={{ fontSize: 14, fontWeight: 600, color: C.text, marginBottom: 6 }}>
              No connections yet
            </div>
            <div style={{ fontSize: 12, color: C.muted }}>
              Upload a spreadsheet or connect to a database to get started
            </div>
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 16 }}>
            {connections.map(conn => (
              <ConnectionCard
                key={conn.id || conn._id}
                conn={conn}
                plugin={installedPlugins.find(p => p.id === conn.dbType)}
                onEdit={handleEditConnection}
                onPreview={handlePreviewData}
                onExplore={(c) => {
                  setExplorerConnection(c);
                  onContextChange({
                    kind: 'connection',
                    id: c.id || c._id,
                    name: c.name,
                    summary: `${c.dbType || 'unknown'} · ${c.connectionType || ''}`.trim(),
                  });
                }}
                onDelete={handleDeleteConnection}
              />
            ))}
          </div>
        )}
      </div>

      {/* Connection type picker */}
      <ConnectionTypeSelector
        open={isConnectionTypeSelectorOpen}
        onClose={() => setTypeSelectorOpen(false)}
        onSelectType={handleConnectionTypeSelect}
      />

      {/* Spreadsheet upload */}
      <Modal
        title={editingSchema ? 'Edit Data Schema' : editingConnection ? 'Edit Data Source' : 'Upload Spreadsheet'}
        open={isUploadModalOpen}
        onCancel={() => { setUploadModalOpen(false); setEditingConnection(null); setEditingSchema(null); }}
        footer={null}
        width={1000}
        destroyOnClose
      >
        <DataSourceUpload
          onUploadComplete={handleUploadComplete}
          onCancel={() => { setUploadModalOpen(false); setEditingConnection(null); setEditingSchema(null); }}
          editingConnection={editingConnection}
          editingSchema={editingSchema}
        />
      </Modal>

      {/* Database connection form */}
      {ActiveForm && (
        <Modal
          title={getModalTitle(activeDbType)}
          open={Boolean(activeDbType)}
          onCancel={() => {
            if (window.electronAPI?.oauth?.cancelServer) window.electronAPI.oauth.cancelServer(3000);
            setActiveDbType(null);
            setEditingConnection(null);
          }}
          footer={null}
          width={640}
          destroyOnClose
        >
          <ActiveForm />
        </Modal>
      )}

      {/* Data preview */}
      <DataPreviewModal
        open={isPreviewOpen}
        data={previewData}
        onClose={() => setPreviewOpen(false)}
      />

      {/* Database explorer */}
      <Modal
        title={
          <Space>
            <CompassOutlined />
            {explorerConnection ? `Explore — ${explorerConnection.name}` : 'Database Explorer'}
          </Space>
        }
        open={Boolean(explorerConnection)}
        onCancel={() => setExplorerConnection(null)}
        footer={null}
        width={1100}
        destroyOnClose
        bodyStyle={{ padding: 0, height: 580, overflow: 'hidden' }}
      >
        {explorerConnection && (
          <DatabaseExplorer
            connection={explorerConnection}
            onClose={() => setExplorerConnection(null)}
          />
        )}
      </Modal>
    </div>
  );
};

export default ConnectionsTab;
