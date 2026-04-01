import React, { useState, useEffect } from 'react';
import { Button, Card, List, Typography, Space, Tag, Dropdown, Menu, Modal, message } from 'antd';
import {
  PlusOutlined,
  DatabaseOutlined,
  FileExcelOutlined,
  EditOutlined,
  DeleteOutlined,
  EyeOutlined,
  MoreOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  CompassOutlined,
} from '@ant-design/icons';
import axios from 'axios';

import DataPreviewModal       from './DataPreviewModal';
import DataSourceUpload       from './DataSourceUpload';
import ConnectionTypeSelector from './ConnectionTypeSelector';

import SpreadsheetConnectionForm   from './connections/SpreadsheetConnectionForm';
import DynamicConnectionForm       from './connections/DynamicConnectionForm';
import LocalFileConnectionForm     from './connections/LocalFileConnectionForm';

import DatabaseExplorer from '../DatabaseExplorer/DatabaseExplorer';

import { connectionsDb } from '../../utils/localDb';

const { Title, Text } = Typography;

// ─────────────────────────────────────────────────────────────────────────────

const ConnectionsTab = () => {
  const [connections, setConnections]                       = useState([]);
  const [isConnectionTypeSelectorOpen, setTypeSelectorOpen] = useState(false);
  const [isUploadModalOpen, setUploadModalOpen]             = useState(false);
  const [activeDbType, setActiveDbType]                     = useState(null);
  const [editingConnection, setEditingConnection]           = useState(null);
  const [editingSchema, setEditingSchema]                   = useState(null);
  const [previewData, setPreviewData]                       = useState(null);
  const [isPreviewOpen, setPreviewOpen]                     = useState(false);
  const [explorerConnection, setExplorerConnection]         = useState(null);
  const [installedPlugins, setInstalledPlugins]             = useState([]);
  const [pluginsLoaded, setPluginsLoaded]                   = useState(false);

  useEffect(() => {
    fetchConnections();
    loadInstalledPlugins();
  }, []);

  // Load installed plugins
  const loadInstalledPlugins = async () => {
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
      setPluginsLoaded(true);
    }
  };

  // ── helpers ───────────────────────────────────────────────────────────────

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

  // ── fetch ─────────────────────────────────────────────────────────────────

  const fetchConnections = async () => {
    if (!isLoggedIn()) {
      const local = await connectionsDb.getAll();
      console.log('local: ', local)
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

  // ── type selector ─────────────────────────────────────────────────────────

  const handleConnectionTypeSelect = (type) => {
    setEditingConnection(null);

    // For file uploads (spreadsheet, json, sqlite, nedb, parquet, avro), use local file connection form
    if (['spreadsheet', 'json', 'sqlite', 'nedb', 'parquet', 'avro'].includes(type)) {
      setActiveDbType(type);
    } else {
      // Database connections
      setActiveDbType(type);
    }
  };

  // ── test connection ───────────────────────────────────────────────────────

  const handleTestConnection = async (dbType, config) => {
    let result;

    // Prefer direct Electron IPC (no backend required)
    if (window.electronAPI?.dbConnect) {
      // console.log('dbType, config: ', dbType, config)
      result = await window.electronAPI.dbConnect.test(dbType, config);
      // console.log('result: ', result)
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

    if (result.success) {
      message.success(result.message || 'Connection successful!');
    } else {
      message.error(result.message || 'Connection failed.');
    }

    return result;
  };

  // ── save DB connection ─────────────────────────────────────────────────────

  const handleSaveDbConnection = async (connectionData) => {
    const connectionId = editingConnection?.id || editingConnection?._id;
    const isEditing = Boolean(connectionId);

    // File connections are always saved locally — only the path is stored, nothing is uploaded
    const isFileConnection = connectionData.connectionType === 'file';

    if (!isLoggedIn() || isFileConnection) {
      try {
        // For database connections, separate sensitive credentials from connection data
        if (connectionData.connectionType === 'database' && connectionData.dbConfig && window.electronAPI?.dbCredentials) {
          const { dbConfig, ...connectionDataWithoutConfig } = connectionData;

          let sensitiveFields = {};
          let nonSensitiveConfig = {};

          // Get the plugin's config schema to determine which fields are sensitive
          const plugin = installedPlugins.find(p => p.id === connectionData.dbType);
          console.log('plugin: ', plugin.configSchema)
          if (plugin && plugin.configSchema && plugin.configSchema.fields) {
            // Dynamically separate sensitive and non-sensitive fields based on plugin schema
            plugin.configSchema.fields.forEach(field => {
              const fieldValue = dbConfig[field.name];
              if (fieldValue !== undefined) {
                if (field.sensitive) {
                  sensitiveFields[field.name] = fieldValue;
                } else {
                  nonSensitiveConfig[field.name] = fieldValue;
                }
              }
            });
          } else {
            // Fallback: treat password, username, host, uri as sensitive
            sensitiveFields = {
              password: dbConfig.password,
              username: dbConfig.username,
              host: dbConfig.host,
              uri: dbConfig.uri,
            };

            nonSensitiveConfig = {
              port: dbConfig.port,
              database: dbConfig.database,
              ssl: dbConfig.ssl,
              instanceName: dbConfig.instanceName,
              engine: dbConfig.engine,
              schema: dbConfig.schema,
            };
          }

          // Prepare connection data with only non-sensitive config
          const safeConnectionData = {
            ...connectionDataWithoutConfig,
            dbConfig: nonSensitiveConfig
          };

          if (isEditing) {
            await connectionsDb.update(connectionId, safeConnectionData);

            // Update credentials (completely replaces existing credentials and closes cached connection)
            await window.electronAPI.dbCredentials.update(connectionId, sensitiveFields, connectionData.dbType);
            setConnections(prev => prev.map(c =>
              (c.id || c._id) === connectionId ? { ...c, ...safeConnectionData } : c
            ));
            message.success('Connection updated securely.');
          } else {
            const saved = await connectionsDb.save(safeConnectionData);
            // Save credentials separately (encrypted) using the new connection ID
            await window.electronAPI.dbCredentials.save(saved.id, sensitiveFields);
            setConnections(prev => [saved, ...prev]);
            message.success('Connection saved securely.');
          }
        } else {
          // Non-database connections (file, API) - save as-is
          if (isEditing) {
            await connectionsDb.update(connectionId, connectionData);
            setConnections(prev => prev.map(c =>
              (c.id || c._id) === connectionId ? { ...c, ...connectionData } : c
            ));
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
      const payload = isEditing ? { ...connectionData, status: 'untested', connectionId } : { ...connectionData, status: 'untested' };
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

  // ── edit ──────────────────────────────────────────────────────────────────

  const handleEditConnection = (connection) => {
    setEditingConnection(connection);
    if (connection.connectionType === 'database') {
      setActiveDbType(connection.dbType);
    } else if (connection.connectionType === 'file') {
      // For file connections, check dbType or fileType
      const fileType = connection.dbType || connection.fileType;
      if (['sqlite', 'nedb', 'json', 'parquet', 'avro'].includes(fileType)) {
        setActiveDbType(fileType);
      } else {
        // Legacy spreadsheet connections
        setActiveDbType('spreadsheet');
        setUploadModalOpen(true);
      }
    } else {
      setActiveDbType('spreadsheet');
      setUploadModalOpen(true);
    }
  };

  const handleEditSchema = (connection) => {
    setEditingSchema(connection);
    setEditingConnection(null);
    setUploadModalOpen(true);
  };

  // ── delete ────────────────────────────────────────────────────────────────

  const handleDeleteConnection = (connection) => {
    Modal.confirm({
      title: 'Delete Connection',
      content: 'Are you sure? This cannot be undone.',
      okText: 'Delete',
      okType: 'danger',
      cancelText: 'Cancel',
      async onOk() {
        const connectionId = connection.id || connection._id;
        if (!isLoggedIn()) {
          await connectionsDb.delete(connectionId);

          // Also delete stored credentials for database connections
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
            { headers: { 'Content-Type': 'application/json', 'auth-token': localStorage.getItem('auth-token') } },
          );
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

  // ── spreadsheet upload complete ───────────────────────────────────────────

  const handleUploadComplete = () => {
    fetchConnections();
    setUploadModalOpen(false);
    setEditingConnection(null);
    message.success(editingConnection ? 'Data source updated.' : 'Data source created.');
  };

  // ── preview ───────────────────────────────────────────────────────────────

  const handlePreviewData = async (connection) => {
    // ── local file preview (no API required) ──────────────────────────────
    if (connection.connectionType === 'file') {
      // Handle SQLite and NeDB database files
      if (connection.dbType === 'sqlite' || connection.dbType === 'nedb') {
        const filePath = connection.fileInfo?.filePath;
        if (!filePath) {
          message.error('File path not found');
          return;
        }

        if (!window.electronAPI?.db?.readLocalCollection) {
          message.warning('Local database preview requires the desktop app.');
          return;
        }

        const hide = message.loading('Reading local database…', 0);
        try {
          const storageType = connection.dbType;
          const result = await window.electronAPI.db.readLocalCollection(filePath, 1000, storageType, null, null);
          hide();

          if (!result.success) {
            message.error('Failed to read database: ' + result.message);
            return;
          }

          const rows = result.rows || [];
          const cols = rows.length > 0 ? Object.keys(rows[0]) : [];

          setPreviewData({
            connection,
            data: rows.map((r, i) => ({ ...r, _sampleIndex: i + 1 })),
            columns: cols,
            metadata: {
              totalRows: rows.length,
              dbType: connection.dbType,
              tables: result.tables || [],
              currentTable: result.currentTable
            },
          });
          setPreviewOpen(true);
        } catch (err) {
          hide();
          message.error('Failed to read database: ' + err.message);
        }
        return;
      }

      // Handle legacy spreadsheet files
      if (!window.electronAPI?.fileReader) {
        message.warning('Local file preview requires the desktop app.');
        return;
      }

      let filePath = connection.fileInfo?.filePath;

      // Path missing (connection saved before path tracking) — let user re-pick
      if (!filePath) {
        const dialogResult = await window.electronAPI.openFileDialog();
        if (dialogResult.canceled || !dialogResult.filePaths?.length) return;
        filePath = dialogResult.filePaths[0];
      }

      const hide = message.loading('Reading local file…', 0);
      try {
        const result = await window.electronAPI.fileReader.readRows(filePath, 1000);
        hide();
        if (!result.success) {
          message.error('Failed to read file: ' + result.message);
          return;
        }
        const sheetName = result.sheets[0];
        const sheetData = result.data[sheetName];
        const rows = sheetData.rows.map((r, i) => ({ ...r, _sampleIndex: i + 1 }));
        const cols = sheetData.columns;
        setPreviewData({
          connection,
          data: rows,
          columns: cols,
          metadata: { sheets: result.sheets, activeSheet: sheetName, totalRows: rows.length },
        });
        setPreviewOpen(true);
      } catch (err) {
        hide();
        message.error('Failed to read file: ' + err.message);
      }
      return;
    }

    // ── API-based preview for non-file connections ─────────────────────────
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

  // ── dynamic plugin mappings ───────────────────────────────────────────────

  // Build type info from installed plugins
  const getPluginTypeInfo = () => {
    const typeInfo = {};
    installedPlugins.forEach(plugin => {
      typeInfo[plugin.id] = {
        label: plugin.metadata?.displayName || plugin.name,
        color: getPluginColor(plugin.id)
      };
    });
    return typeInfo;
  };

  const getPluginColor = (pluginId) => {
    const colorMap = {
      postgres: '#336791',
      mysql: '#e48b00',
      mssql: '#0078d4',
      mongodb: '#00a550',
    };
    return colorMap[pluginId] || '#6c757d';
  };

  // Get modal title for plugin
  const getModalTitle = (dbType) => {
    const titleMap = {
      sqlite: 'Connect SQLite Database',
      nedb: 'Connect NeDB Database',
      json: 'Upload JSON File',
      spreadsheet: 'Add Spreadsheet',
      parquet: 'Upload Parquet File',
      avro: 'Upload Avro File',
    };

    if (titleMap[dbType]) {
      return titleMap[dbType];
    }

    const plugin = installedPlugins.find(p => p.id === dbType);
    if (plugin) {
      return `Connect to ${plugin.metadata?.displayName || plugin.name}`;
    }

    return 'Connect to Database';
  };

  // ── card type info ─────────────────────────────────────────────────────────

  const getTypeInfo = (conn) => {
    if (conn.connectionType === 'database') {
      const pluginTypeInfo = getPluginTypeInfo();
      return pluginTypeInfo[conn.dbType] || { label: 'Database', color: '#6c757d' };
    }
    if (conn.connectionType === 'api') {
      const map = {
        clover_pos: { label: 'Clover POS', color: '#52c41a' },
        square_pos: { label: 'Square POS', color: '#722ed1' },
        shopify:    { label: 'Shopify',    color: '#95de64' },
      };
      return map[conn.apiType] || { label: 'API', color: '#1890ff' };
    }

    // File-based connections
    if (conn.connectionType === 'file') {
      const fileTypeMap = {
        csv: { label: 'CSV → SQLite', color: '#fa8c16' },
        excel: { label: 'Excel → SQLite', color: '#13c2c2' },
        parquet: { label: 'Parquet → SQLite', color: '#9254de' },
        avro: { label: 'Avro → SQLite', color: '#eb2f96' },
        spreadsheet: { label: 'Spreadsheet', color: '#1890ff' },
        json: { label: 'JSON → NeDB', color: '#fa8c16' },
        sqlite: { label: 'SQLite', color: '#0f80cc' },
        nedb: { label: 'NeDB', color: '#52c41a' },
      };
      return fileTypeMap[conn.fileType] || fileTypeMap[conn.dbType] || { label: 'File', color: '#8c8c8c' };
    }

    // Legacy fallback
    return conn.fileType === 'csv'
      ? { label: 'CSV',   color: '#fa8c16' }
      : { label: 'Excel', color: '#13c2c2' };
  };

  const getConnectionMenu = (conn) => (
    <Menu>
      <Menu.Item key="edit" icon={<EditOutlined />} onClick={() => handleEditConnection(conn)}>
        Edit Connection
      </Menu.Item>
      {conn.connectionType === 'database' && (
        <Menu.Item key="explore" icon={<CompassOutlined />} onClick={() => setExplorerConnection(conn)}>
          Explore Database
        </Menu.Item>
      )}
      {conn.connectionType !== 'database' && (
        <Menu.Item key="preview" icon={<EyeOutlined />} onClick={() => handlePreviewData(conn)}>
          Preview Data
        </Menu.Item>
      )}
      <Menu.Divider />
      <Menu.Item key="delete" icon={<DeleteOutlined />} danger onClick={() => handleDeleteConnection(conn)}>
        Delete
      </Menu.Item>
    </Menu>
  );

  // ── active DB form component ──────────────────────────────────────────────

  const getActiveFormComponent = () => {
    if (!activeDbType) return null;

    // Local file connections (sqlite, nedb, json, spreadsheet, parquet, avro)
    if (['sqlite', 'nedb', 'json', 'spreadsheet', 'parquet', 'avro'].includes(activeDbType)) {
      return () => (
        <LocalFileConnectionForm
          fileType={activeDbType}
          onSave={handleSaveDbConnection}
          onCancel={() => { setActiveDbType(null); setEditingConnection(null); }}
          editingConnection={editingConnection}
        />
      );
    }

    // Database connectors use dynamic form based on plugin
    const plugin = installedPlugins.find(p => p.id === activeDbType);
    console.log('plugin: ', plugin)
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

  // ── render ────────────────────────────────────────────────────────────────

  return (
    <div className="workflows-container">
      <div className="workflows-header">
        <div>
          <Title level={4} style={{ margin: 0 }}>Data Source Connections</Title>
          <Text type="secondary">Manage spreadsheet uploads and database connections</Text>
        </div>
        <Button type="primary" icon={<PlusOutlined />} size="large" onClick={() => setTypeSelectorOpen(true)}>
          New Connection
        </Button>
      </div>

      <div className="workflows-content">
        {connections.length === 0 ? (
          <div className="empty-state">
            <DatabaseOutlined style={{ fontSize: 48, color: '#ccc' }} />
            <Title level={4} type="secondary">No connections yet</Title>
            <Text type="secondary" style={{ display: 'block', marginBottom: 24 }}>
              Upload a spreadsheet or connect to a database to get started
            </Text>
          </div>
        ) : (
          <div className="workflow-list">
            <List
              grid={{ gutter: 16, column: 3 }}
              dataSource={connections}
              renderItem={(conn) => {
                const info = getTypeInfo(conn);
                return (
                  <List.Item style={{ display: 'flex' }}>
                    <Card
                      className="connection-card"
                      style={{ width: '100%', maxWidth: '100%', flex: 1 }}
                      bodyStyle={{ minHeight: '160px' }}
                      title={
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%' }}>
                          <Space style={{ flex: 1, minWidth: 0 }}>
                            {conn.connectionType === 'file' ? <FileExcelOutlined /> : <DatabaseOutlined />}
                            <span style={{
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                              maxWidth: '200px'
                            }}>
                              {conn.name}
                            </span>
                          </Space>
                          <Dropdown overlay={getConnectionMenu(conn)} trigger={['click']} placement="bottomRight">
                            <Button type="text" icon={<MoreOutlined />} size="small" />
                          </Dropdown>
                        </div>
                      }
                    >
                      <div style={{
                        marginBottom: 10,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap'
                      }}>
                        <Text type="secondary">{conn.description}</Text>
                      </div>

                      <Space style={{ marginBottom: 10 }}>
                        <Tag color={info.color}>{info.label}</Tag>
                        {/* <span style={{ fontSize: 12, color: '#666' }}>
                          {conn.status === 'ready' || conn.status === 'uploaded'
                            ? <><CheckCircleOutlined style={{ color: '#52c41a' }} /> {conn.status}</>
                            : conn.status === 'untested'
                            ? <span style={{ color: '#faad14' }}>untested</span>
                            : <><CloseCircleOutlined style={{ color: '#ff4d4f' }} /> {conn.status}</>}
                        </span> */}
                      </Space>

                      {conn.connectionType === 'database' && (
                        <div style={{ fontSize: 12, color: '#666', lineHeight: 1.8 }}>
                          {conn.dbType === 'mongodb' ? (
                            <div>MongoDB Connection (credentials secured)</div>
                          ) : (
                            <>
                              {conn.dbConfig?.host && (
                                <div style={{
                                  overflow: 'hidden',
                                  textOverflow: 'ellipsis',
                                  whiteSpace: 'nowrap'
                                }}>
                                  Host: {conn.dbConfig.host}{conn.dbConfig.port ? `:${conn.dbConfig.port}` : ''}
                                </div>
                              )}
                              {conn.dbConfig?.database && (
                                <div style={{
                                  overflow: 'hidden',
                                  textOverflow: 'ellipsis',
                                  whiteSpace: 'nowrap'
                                }}>
                                  Database: {conn.dbConfig.database}
                                </div>
                              )}
                              {conn.dbConfig?.engine && (
                                <div style={{
                                  overflow: 'hidden',
                                  textOverflow: 'ellipsis',
                                  whiteSpace: 'nowrap'
                                }}>
                                  Engine: {conn.dbConfig.engine}
                                </div>
                              )}
                            </>
                          )}
                        </div>
                      )}

                      {conn.connectionType === 'file' && (
                        <div style={{ fontSize: 12, color: '#666', lineHeight: 1.8 }}>
                          {conn.fileInfo?.originalName && (
                            <div style={{
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap'
                            }}>
                              File: {conn.fileInfo.originalName}
                            </div>
                          )}
                          {conn.fileInfo?.fileSize && (
                            <div>Size: {(conn.fileInfo.fileSize / 1024 / 1024).toFixed(2)} MB</div>
                          )}
                        </div>
                      )}

                      {conn.workflowName && (
                        <div style={{
                          fontSize: 12,
                          color: '#666',
                          marginTop: 4,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap'
                        }}>
                          <strong>Used by:</strong> {conn.workflowName}
                        </div>
                      )}

                      {conn.createdAt && (
                        <div style={{ fontSize: 12, color: '#aaa', marginTop: 4 }}>
                          Created: {new Date(conn.createdAt).toLocaleDateString()}
                        </div>
                      )}
                    </Card>
                  </List.Item>
                );
              }}
            />
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

      {/* Database connection form (dynamic based on installed plugins) */}
      {ActiveForm && (
        <Modal
          title={getModalTitle(activeDbType)}
          open={Boolean(activeDbType)}
          onCancel={() => {
            // Cancel any active OAuth server
            if (window.electronAPI?.oauth?.cancelServer) {
              window.electronAPI.oauth.cancelServer(3000);
            }
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
