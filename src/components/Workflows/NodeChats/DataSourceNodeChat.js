import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import axios from 'axios';
import { Select, Modal, message as antdMessage } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import { connectionsDb } from '../../../utils/localDb';
import { getWorkflowAssistance, extractSQL } from '../../../utils/workflowAI';
import ChatArea from '../../Chat/ChatArea';
import { FileExcelOutlined, FileTextOutlined } from '@ant-design/icons';
import { loadTableSchema } from '../../../utils/tableSchemaUtils';
import { ReactComponent as PostgresIcon } from '../../ConnectorImages/Postgres.svg';
import { ReactComponent as MysqlIcon } from '../../ConnectorImages/Mysql.svg';
import { ReactComponent as MssqlIcon } from '../../ConnectorImages/Mssql.svg';
import { ReactComponent as MongodbIcon } from '../../ConnectorImages/Mongodb.svg';
import { ReactComponent as SqlliteIcon } from '../../ConnectorImages/Sqllite.svg';
import { ReactComponent as GoogleCloudStorageIcon } from '../../ConnectorImages/GoogleCloudStorage.svg';
import { ReactComponent as DropboxIcon } from '../../ConnectorImages/Dropbox.svg';
import { ReactComponent as GoogleDriveIcon } from '../../ConnectorImages/GoogleDrive.svg';
import { ReactComponent as GoogleSheetsIcon } from '../../ConnectorImages/GoogleSheets.svg';
import { buildChatPrompt } from '../../../utils/chatPrompts';
import CloudStorageBrowser from '../CloudStorageBrowser';
import GoogleDrivePicker from '../GoogleDrivePicker';
import ConnectionTypeSelector from '../ConnectionTypeSelector';
import DynamicConnectionForm from '../connections/DynamicConnectionForm';
import LocalFileConnectionForm from '../connections/LocalFileConnectionForm';

const { Option } = Select;
// ─────────────────────────────────────────────────────────────────────────────
// DataSource Node Chat Component
// Handles database, file (CSV/Excel), and API (POS) connections
// ─────────────────────────────────────────────────────────────────────────────

// Helper to get database icon component
const getDbIcon = (dbType) => {
  const iconMap = {
    postgres: PostgresIcon,
    mysql: MysqlIcon,
    mssql: MssqlIcon,
    mongodb: MongodbIcon,
    sqlite: SqlliteIcon,
    gcs: GoogleCloudStorageIcon,
    dropbox: DropboxIcon,
    'google-drive': GoogleDriveIcon,
    'google-sheets': GoogleSheetsIcon,
  };
  return iconMap[dbType?.toLowerCase()] || null;
};

// Helper to get connection icon (database or file)
const getConnectionIcon = (connection) => {
  // File-based connections
  if (connection.connectionType === 'file') {
    const fileName = connection.fileInfo?.fileName?.toLowerCase() || '';
    if (fileName.endsWith('.csv')) {
      return <FileTextOutlined style={{ fontSize: 20 }} />;
    }
    // Excel files (.xlsx, .xls)
    return <FileExcelOutlined style={{ fontSize: 20 }} />;
  }

  // Database connections
  const IconComponent = getDbIcon(connection.dbType);
  return IconComponent ? <IconComponent style={{ width: 20, height: 20 }} /> : null;
};


const formatTimestamp = (ts) => {
  const diff = Math.floor((Date.now() - new Date(ts)) / 60000);
  if (diff < 1) return 'Just now';
  if (diff < 60) return `${diff}m`;
  return `${Math.floor(diff / 60)}h`;
};

const DataSourceNodeChat = ({
  node,
  initialChat,
  onSave,
  onLoadDatabaseTables,
  onConfigUpdate,
  onPreviewConfigUpdate,
  executing = false
}) => {

  const messagesEndRef = useRef(null);
  const chatContainerRef = useRef(null);
  const inputRef = useRef(null);
  const initialized = useRef(false);

  const [chat, setChat] = useState(initialChat);
  const [inputValue, setInputValue] = useState('');
  const [connections, setConnections] = useState([]);
  const [loading, setLoading] = useState(false);
  const [aiLoading, setAiLoading] = useState(false);

  // Database specific state
  const [selConn, setSelConn] = useState(null);
  const [dbTables, setDbTables] = useState([]); // Array of table names for AI
  const [dbTableObjects, setDbTableObjects] = useState([]); // Full table objects with schema info
  const [aiSelectedTables, setAiSelectedTables] = useState([]);
  const [selectedTableSchemas, setSelectedTableSchemas] = useState({});
  const [connectionComplete, setconnectionComplete] = useState(false);
  const [latestWithSQL, setLatestWithSQL] = useState(null);
  const [saveState, setSaveState] = useState(false);
  const [selectedChoice, setSelectedChoice] = useState({});
  const [tableAnalysisContext, setTableAnalysisContext] = useState(null); // Store initial analysis for context
  const [disableInput, setDisableInput] = useState(false); // Store initial analysis for context
  const [processingEnvironment, setProcessingEnvironment] = useState(null); // 'database' or 'local'
  const [tableSchema, setTableSchema] = useState(null); // { tableName, columns, sampleData }

  // Cloud Storage Browser state
  const [cloudStorageBrowserOpen, setCloudStorageBrowserOpen] = useState(false);
  const [cloudStorageConnection, setCloudStorageConnection] = useState(null);
  const [pluginManager, setPluginManager] = useState(null);

  // Connection Type Selector state
  const [isConnectionTypeSelectorOpen, setIsConnectionTypeSelectorOpen] = useState(false);
  const [activeDbType, setActiveDbType] = useState(null);
  const [installedPlugins, setInstalledPlugins] = useState([]);

  // Connections Tab modal state
  const [isConnectionsTabOpen, setIsConnectionsTabOpen] = useState(false);

  // REST API DataSource state
  //   apiFetchPrompt       — user's last natural-language request
  //   apiFetchCode         — async JS function expression (with placeholders)
  //                          that the main process evaluates and runs
  //   apiFetchExplanation  — one-line summary from the AI
  //   apiFetchResult       — result of the most recent live fetch (rowCount/localPath)
  const [apiFetchPrompt, setApiFetchPrompt] = useState(null);
  const [apiFetchCode, setApiFetchCode] = useState(null);
  const [apiFetchExplanation, setApiFetchExplanation] = useState(null);
  const [apiFetchResult, setApiFetchResult] = useState(null);
  const [apiRunning, setApiRunning] = useState(false);
  // True when the AI has produced a fetch function that has not yet been
  // executed against the live endpoint. Drives the Run & Save button so a
  // saved node reopened later does not prompt the user to re-run unless
  // they have refined the request.
  const [apiFetchDirty, setApiFetchDirty] = useState(false);

  // console.log('node: ', node)
  // console.log('initialChat: ', initialChat)
  // console.log('chat: ', chat)
  // ─────────────────────────────────────────────────────────────────────────
  // Initialize
  // ─────────────────────────────────────────────────────────────────────────

  useEffect(() => {
    if (!initialized.current) {
      initialized.current = true;
      
      console.log('DataSourceNodeChat initializing. initialChat length:', initialChat.length);

      // Restore state from saved config if reopening a saved node
      const savedConfig = node?.data?.config;
      if (savedConfig && initialChat.length > 0) {
        // console.log('Restoring saved config:', savedConfig);

        // Restore connection info
        if (savedConfig.connectionId || savedConfig.sourceConnectionId || savedConfig.sourceApiConnectionId) {
          const conn = {
            id: savedConfig.sourceConnectionId,
            name: savedConfig.sourceConnectionName,
            connectionType: savedConfig.sourceConnectionType,
            dbType: savedConfig.sourceDbType,
            dbConfig: savedConfig.sourceDbConfig,
            dbCategory: savedConfig.sourceDbCategory,
            fileType: savedConfig.sourceType,
            apiType: savedConfig.sourceType
          };
          setSelConn(conn);
          setconnectionComplete(true);

          // Restore selectedChoice with connection data
          setSelectedChoice({
            label: conn.name,
            value: conn.id,
            _data: conn
          });

          // Reload database tables for database connections (silent mode - don't add messages)
          if (savedConfig.connectionType === 'database') {
            loadDatabaseTables(conn, true);

            // Restore selected tables/indexes
            if (savedConfig.selectedTables) {
              setAiSelectedTables(savedConfig.selectedTables);
            } else if (savedConfig.sourceIndexName) {
              // For vector databases, restore from sourceIndexName
              const indexWithNamespace = savedConfig.sourceNamespace
                ? `${savedConfig.sourceIndexName}/${savedConfig.sourceNamespace}`
                : savedConfig.sourceIndexName;
              setAiSelectedTables([indexWithNamespace]);
            } else if (savedConfig.sourceTableName) {
              // Fallback to sourceTableName
              setAiSelectedTables([savedConfig.sourceTableName]);
            } else if (savedConfig.sourceCollection) {
              // Fallback to sourceCollection for NoSQL
              setAiSelectedTables([savedConfig.sourceCollection]);
            }

            // Restore query for preview
            if (savedConfig.sql || savedConfig.previewSql) {
              setLatestWithSQL({
                sql: savedConfig.sql || savedConfig.previewSql,
                previewSql: savedConfig.previewSql || savedConfig.sql,
                explanation: savedConfig.sqlExplanation || '',
                queryDescription: savedConfig.queryDescription || ''
              });
            }

            // Restore table schema
            if (savedConfig.sourceTableSchema) {
              setTableSchema(savedConfig.sourceTableSchema);
            }
          } else if (savedConfig.sourceConnectionType === 'api' || savedConfig.apiFetchCode) {
            // Restore REST API fetch function so the user can refine or re-run
            // it. Rebuild selConn so it points at the original API connection,
            // not the local-nedb placeholder used for downstream routing.
            const apiConn = {
              id: savedConfig.sourceApiConnectionId,
              name: savedConfig.sourceApiConnectionName,
              connectionType: 'database',
              dbType: 'rest-api',
              dbConfig: savedConfig.apiConnectionPublicConfig || {},
              dbCategory: 'API',
            };
            setSelConn(apiConn);

            setApiFetchPrompt(savedConfig.apiFetchPrompt || null);
            setApiFetchCode(savedConfig.apiFetchCode || null);
            setApiFetchExplanation(savedConfig.apiFetchExplanation || '');
            if (savedConfig.sourceLocalPath || savedConfig.sourceCollection) {
              setApiFetchResult({
                rowCount: null,
                localPath: savedConfig.sourceLocalPath,
                collection: savedConfig.sourceCollection,
              });
            }
            // The fetch has already been run and saved — do not re-prompt for
            // a run until the user refines the request (which flips the
            // dirty flag).
            setApiFetchDirty(false);
          } else if (savedConfig.connectionType === 'file') {
            // Restore for file-based connections (SQLite, NeDB, LanceDB)
            // Add file path information if it's a file connection
            if (savedConfig.sourceLocalPath) {
              conn.fileInfo = {
                filePath: savedConfig.sourceLocalPath
              };
            }

            // Restore selected tables
            if (savedConfig.sourceTableName) {
              setAiSelectedTables([savedConfig.sourceTableName]);
            } else if (savedConfig.sourceIndexName) {
              // For LanceDB file connections
              setAiSelectedTables([savedConfig.sourceIndexName]);
            } else if (savedConfig.sourceCollection) {
              // For NeDB file connections
              setAiSelectedTables([savedConfig.sourceCollection]);
            }

            // Restore table schema
            if (savedConfig.sourceTableSchema) {
              setTableSchema(savedConfig.sourceTableSchema);
            }
          }
        }
      } else {
        // New node - show initial message
        if (initialChat.length === 0) {
          setDisableInput(true);
          addBotMessage("Hi! Let's configure your data source.\nWhich connection would you like to use?", true, 'connection', 'connectionId');
        }
      }

      loadConnections();
    }
  }, []);

  // Auto-scroll to bottom when chat messages change
  useEffect(() => {
    if (messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [chat]);

  // Update node config when SQL changes to trigger data preview refresh
  useEffect(() => {
    if (latestWithSQL && latestWithSQL.previewSql && onPreviewConfigUpdate && selConn) {
      const previewConfig = {
        connectionId: selConn.id,
        connectionName: selConn.name,
        connectionType: selConn.connectionType,
        dbType: selConn.dbType,
        dbConfig: selConn.dbConfig,
        sourceType: selConn.dbType,
        sql: latestWithSQL.sql,
        previewSql: latestWithSQL.previewSql,
        sqlExplanation: latestWithSQL.explanation,
        queryDescription: latestWithSQL.queryDescription
      };
      onPreviewConfigUpdate(node.id, previewConfig);
    }
  }, [latestWithSQL?.previewSql]);

  // ─────────────────────────────────────────────────────────────────────────
  // Core Functions
  // ─────────────────────────────────────────────────────────────────────────

  const addBotMessage = (text, responseRequired = false, responseType = 'text', ref = '', placeholder = '', metadata = null) => {
    setChat(prev => [...prev, {
      id: `bot-${Date.now()}-${Math.random()}`,
      sender: 'bot',
      text,
      timestamp: new Date(),
      responseRequired,
      responseType,
      ref,
      placeholder: placeholder || 'Type your response…',
      metadata,
    }]);
  };

  const addUserMessage = (text, ref, value, data = null) => {
    const userMsg = {
      id: `user-${Date.now()}-${Math.random()}`,
      sender: 'user',
      text,
      timestamp: new Date(),
      ref,
      value: value || text,
      data,
    };
    setChat(prev => [...prev, userMsg]);
    return userMsg;
  };

  // ─────────────────────────────────────────────────────────────────────────
  // Handle User Responses
  // ─────────────────────────────────────────────────────────────────────────

  const handleUserResponse = async (text, ref, value, data) => {
    const userMsg = addUserMessage(text, ref, value, data);
    // console.log('value, data: ', value, data)
    if (ref === 'connectionId') {
      await handleConnectionSelection(userMsg);
    } else if (ref === 'tableSelection') {
      await handleTableSelection(userMsg);
    } else if (ref === 'sheetSelection') {
      await handleSheetSelection(userMsg);
    } else if (ref === 'apiFetchRequest' || ref === 'apiFetchRefine') {
      await handleApiFetchRequest(userMsg);
    }
    // Removed: processingEnvironment and databaseQuery handlers
  };

  // ─────────────────────────────────────────────────────────────────────────
  // REST API fetch flow
  // ─────────────────────────────────────────────────────────────────────────

  const sanitizeCollectionName = (raw) => {
    const base = String(raw || node?.id || 'api_response')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 64);
    return base || 'api_response';
  };

  const handleApiFetchRequest = async (userMsg) => {
    if (!selConn) return;

    setAiLoading(true);
    try {
      const conversationHistory = chat
        .map(m => `${m.sender === 'user' ? 'User' : 'Assistant'}: ${m.text}`)
        .join('\n');

      const prompt = await buildChatPrompt('restApi.restApiAnalysisRequest', [{
        userRequest: userMsg.text,
        connectionAuthType: selConn.dbConfig?.authType || 'none',
        connectionBaseUrl: selConn.dbConfig?.baseUrl || '',
        connectionApiKeyName: selConn.dbConfig?.apiKeyName || '',
        connectionBasicUser: selConn.dbConfig?.basicUser || '',
        conversationHistory,
      }]);

      const response = await getWorkflowAssistance(
        'rest-api',
        prompt,
        { connectionId: selConn.id, userRequest: userMsg.text },
        chat.map(m => ({ sender: m.sender, text: m.text }))
      );

      let parsed;
      try {
        parsed = JSON.parse(response);
      } catch (err) {
        console.error('[RestApi] failed to parse AI JSON:', err, response);
        addBotMessage('I had trouble understanding that. Could you rephrase the request?', true, 'text', 'apiFetchRefine', 'Try again…');
        return;
      }

      switch (parsed.action) {
        case 'answer_directly': {
          addBotMessage(parsed.directAnswer || '', false);
          addBotMessage(
            'Would you like to refine further, or describe a different call?',
            true,
            'text',
            'apiFetchRefine',
            'Describe the data you want to fetch…'
          );
          break;
        }

        case 'ask_questions': {
          addBotMessage(
            parsed.followUpQuestion || 'Could you share a bit more detail?',
            true,
            'text',
            'apiFetchRefine',
            'Provide additional details…'
          );
          break;
        }

        case 'create_plan':
        default: {
          if (!parsed.code || typeof parsed.code !== 'string') {
            addBotMessage('The AI did not return a valid fetch function. Please refine your request.', true, 'text', 'apiFetchRefine', 'Try again…');
            return;
          }
          setApiFetchPrompt(userMsg.text);
          setApiFetchCode(parsed.code);
          setApiFetchExplanation(parsed.explanation || '');
          setApiFetchResult(null);
          setApiFetchDirty(true);

          addBotMessage(
            `✓ Fetch function ready.\n\n${parsed.explanation || 'Fetch function generated.'}`,
            false,
            'text',
            '',
            '',
            {
              javascriptFunction: parsed.code,
            }
          );
          addBotMessage(
            'Refine the request, or click Run & Save to execute the function and cache the data into a local NeDB collection.',
            true,
            'text',
            'apiFetchRefine',
            'Ask for changes or press Run & Save…'
          );
          setSaveState(true);
          break;
        }
      }
    } catch (err) {
      console.error('[handleApiFetchRequest]', err);
      addBotMessage(`Error generating fetch plan: ${err.message}`, false);
    } finally {
      setAiLoading(false);
    }
  };

  /**
   * Fire the live fetch in the main process, materialise rows into NeDB, then
   * emit the complete node config via onSave.
   */
  const runAndSaveApiFetch = async () => {
    if (!selConn || !apiFetchCode) {
      addBotMessage('No fetch function to run yet.', false);
      return;
    }
    if (!window.electronAPI?.dbConnect?.executeRestApiFetch) {
      addBotMessage('REST API execution is not available in this build.', false);
      return;
    }

    setApiRunning(true);
    setSaveState(false);
    try {
      const collection = sanitizeCollectionName(node?.data?.label || node?.id);
      const result = await window.electronAPI.dbConnect.executeRestApiFetch({
        apiConnectionId: selConn.id,
        apiConnectionConfig: selConn.dbConfig || {},
        apiFetchCode,
        nedbCollection: collection,
        operationMode: 'new_table',
      });

      if (!result?.success) {
        addBotMessage(`✗ Fetch failed: ${result?.error || 'Unknown error'}`, false);
        setSaveState(true);
        return;
      }

      const freshResult = {
        rowCount: result.rowCount || 0,
        localPath: result.localPath,
        collection: result.collection || collection,
      };
      setApiFetchResult(freshResult);
      setApiFetchDirty(false);

      addBotMessage(
        `✓ Fetched ${result.rowCount || 0} row${result.rowCount === 1 ? '' : 's'} into "${result.collection || collection}".`,
        false
      );

      // Persist config via the normal save path. Pass freshResult directly
      // since setApiFetchResult above hasn't flushed yet.
      const config = buildConfig(freshResult);
      onSave(config, chat);
    } catch (err) {
      console.error('[runAndSaveApiFetch]', err);
      addBotMessage(`✗ Fetch error: ${err.message}`, false);
      setSaveState(true);
    } finally {
      setApiRunning(false);
    }
  };

  // ─────────────────────────────────────────────────────────────────────────
  // Connection Selection
  // ─────────────────────────────────────────────────────────────────────────

  // Load plugin manager on mount
  useEffect(() => {
    const loadPluginManager = async () => {
      if (window.electronAPI?.dbConnect?.listPlugins) {
        try {
          const result = await window.electronAPI.dbConnect.listPlugins();
          if (result.success) {
            // Create a simple plugin manager object
            const manager = {
              getConnector: (dbType) => {
                const connector = result.connectors?.find(c => c.id === dbType);
                return connector || null;
              }
            };
            setPluginManager(manager);
          }
        } catch (error) {
          console.error('Failed to load plugin manager:', error);
        }
      }
    };

    loadPluginManager();
  }, []);

  // Load installed plugins for connection forms
  useEffect(() => {
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
      }
    };

    loadInstalledPlugins();
  }, []);

  // Handle file selection from cloud storage browser
  const handleCloudFileSelect = async (fileInfo) => {
    setCloudStorageBrowserOpen(false);

    // Create a local file connection from the imported cloud file
    const localConnection = {
      id: `cloud-import-${Date.now()}`,
      name: `[${cloudStorageConnection.name}] ${fileInfo.fileName}`,
      connectionType: 'file',
      dbType: fileInfo.dbType,
      fileInfo: {
        fileName: fileInfo.fileName,
        filePath: fileInfo.localPath,
        tables: fileInfo.tables,
        schemas: fileInfo.schemas // Store schema(s) from import
      },
      cloudSource: fileInfo.cloudSource
    };

    // Save this as a new connection
    try {
      // Add user message with connection data BEFORE saving
      // This ensures buildConfig() picks up the imported file connection, not the cloud storage one
      addUserMessage(
        `${localConnection.name}`,
        'connectionId',
        localConnection.id,
        localConnection
      );

      await connectionsDb.save(localConnection);

      // Update selected connection
      setSelConn(localConnection);
      setconnectionComplete(true);
      setDisableInput(true);
      setLoading(true);

      // Load tables from the imported file (silent mode - we handle messages below) for preview section
      await loadDatabaseTables(localConnection, true);

      // Set up the first table for preview (similar to handleTableSelection)
      if (fileInfo.tables && fileInfo.tables.length > 0) {
        const tableName = fileInfo.tables[0];
        setAiSelectedTables([tableName]);

        // Use saved schema if available, otherwise load from DB
        if (fileInfo.schemas) {
          // Use the first schema (for single table files) or find matching schema
          const schema = Array.isArray(fileInfo.schemas)
            ? fileInfo.schemas.find(s => s.tableName === tableName) || fileInfo.schemas[0]
            : fileInfo.schemas;

          if (schema) {
            setTableSchema(schema);
            console.log('Using saved schema:', schema);
          }
        } else if (fileInfo.dbType !== 'lancedb') {
          // Fallback: Load table schema from DB (skip for LanceDB)
          await loadTableSchemaFromDB({ name: tableName, schema: null }, localConnection);
        }

        // Generate preview query based on database type
        const isNoSQL = fileInfo.dbType === 'nedb';
        const isLanceDB = fileInfo.dbType === 'lancedb';
        let previewQuery;

        if (isLanceDB) {
          // LanceDB - no SQL preview query needed for vector databases
          previewQuery = null;
        } else if (isNoSQL) {
          // NeDB/MongoDB - use JSON query format
          previewQuery = JSON.stringify({
            collection: tableName,
            filter: {},
            limit: 100
          });
        } else {
          // SQLite - use database-specific preview query syntax
          const previewResult = await window.electronAPI.dbConnect.getPreviewQuery(
            fileInfo.dbType || 'sqlite',
            `"${tableName}"`,
            100
          );
          previewQuery = previewResult.success ? previewResult.previewQuery : `SELECT * FROM "${tableName}" LIMIT 100`;
        }

        // Store the query for preview (skip for LanceDB)
        if (!isLanceDB) {
          setLatestWithSQL({
            sql: previewQuery,
            previewSql: previewQuery,
            explanation: `Selecting all columns from ${tableName}`,
            queryDescription: `Preview data from ${tableName}`
          });
        }
      }

      addBotMessage(
        `File imported successfully! Tables loaded from "${fileInfo.fileName}". Configuration complete! Click Save below.`,
        false
      );

      // Enable save button
      setSaveState(true);
    } catch (error) {
      console.error('Failed to save cloud import connection:', error);
      addBotMessage('Failed to import file. Please try again.', false);
    }
  };

  const handleConnectionSelection = async (userMsg) => {
    const conn = userMsg.data;
    setSelConn(conn);

    // REST API connection: auth lives on the connection, but the actual
    // endpoint + request shape is authored here via natural language. The
    // resulting fetch plan will be executed in the main process and
    // materialised to a local NeDB collection.
    if (conn.dbType === 'rest-api') {
      setconnectionComplete(true);
      setDisableInput(false);
      const baseUrl = conn.dbConfig?.baseUrl;
      const urlLine = baseUrl ? `\n\nBase URL: ${baseUrl}` : '';
      addBotMessage(
        `Connected to "${conn.name}".${urlLine}\n\nDescribe the request you want to make — which endpoint to call and the HTTP method (e.g., "GET /users?status=active" or "POST /orders with a JSON body").`,
        true,
        'text',
        'apiFetchRequest',
        'e.g. GET /users?status=active'
      );
      return;
    }

    // Check if this is a cloud storage connection
    const isCloudStorage = conn.dbCategory === 'CloudStorage';

    if (isCloudStorage) {
      // Open cloud storage browser
      setCloudStorageConnection(conn);
      setCloudStorageBrowserOpen(true);
      addBotMessage(`Opening cloud storage browser for "${conn.name}"...`, false);
      return;
    }

    // Handle LanceDB file connections separately - tables are already in fileInfo
    if (conn.dbType === 'lancedb' && conn.connectionType === 'file') {
      setDisableInput(true);
      setconnectionComplete(true);

      // Get tables from fileInfo (already loaded during import)
      const tableList = conn.fileInfo?.tables || [];

      if (tableList.length > 0) {
        // Store table names
        setDbTables(tableList);
        setDbTableObjects(tableList.map(t => ({ name: t, schema: null, type: 'table' })));

        addBotMessage(
          `Connected! Found ${tableList.length} table${tableList.length !== 1 ? 's' : ''} in "${conn.name}".\n\nYou can view the schema in the Data Preview panel below.`,
          false
        );
        addBotMessage(
          'Which table would you like to use?',
          true,
          'choice',
          'tableSelection',
          '',
          {
            choices: tableList.map(tableName => ({
              label: tableName,
              value: tableName,
              description: '',
              _data: { name: tableName, schema: null, type: 'table' },
              displayType: 'dropdown'
            }))
          }
        );
      } else {
        addBotMessage('No tables found in this LanceDB. Make sure the directory contains valid .lance table folders.', false);
      }
    }
    // Handle database connections and local database files (SQLite, NeDB)
    else if (conn.connectionType === 'database' || conn.dbType === 'sqlite' || conn.dbType === 'nedb') {
      // Load database tables directly (no processing environment question)
      setDisableInput(true); // Keep input disabled for database connections
      setconnectionComplete(true);
      setLoading(true); // Set loading immediately to hide choices
      await loadDatabaseTables(conn);
    } else {
      // Non-database connections end here (CSV/Excel imported to internal db, JSON imported to NeDB)
      // Keep input disabled since configuration is complete
      setconnectionComplete(true);
      addBotMessage(`"${conn.name}" selected. Configuration complete! Click Save below.`, false);
      setSaveState(true)
    }
  };

  // ─────────────────────────────────────────────────────────────────────────
  // Table Selection
  // ─────────────────────────────────────────────────────────────────────────

  const handleTableSelection = async (userMsg) => {
    const selectedTable = userMsg.data; // Table object with name and schema
    setAiSelectedTables([selectedTable.name]); // Store selected table name

    // Check if this is Google Sheets - need to select sheet/tab
    if (selConn?.dbType === 'google-sheets') {
      setLoading(true);
      try {
        // Get sheets list from the spreadsheet
        const columnsResult = await window.electronAPI.dbConnect.getColumns(
          selConn.dbType,
          selConn.dbConfig,
          selectedTable.schema,
          selectedTable.name, // This is the spreadsheet ID
          selConn.id
        );

        if (columnsResult.success && columnsResult.sheets && columnsResult.sheets.length > 0) {
          setLoading(false);

          addBotMessage(
            `Selected "${selectedTable.displayName || selectedTable.name}". This spreadsheet has ${columnsResult.sheets.length} sheet${columnsResult.sheets.length !== 1 ? 's' : ''}.`,
            false
          );

          addBotMessage(
            'Which sheet would you like to use?',
            true,
            'choice',
            'sheetSelection',
            '',
            {
              choices: columnsResult.sheets.map(sheet => ({
                label: sheet.name,
                value: sheet.name,
                description: `${sheet.rowCount} rows × ${sheet.columnCount} columns`,
                _data: {
                  ...selectedTable,
                  sheetName: sheet.name,
                  sheetIndex: sheet.index
                },
                displayType: 'dropdown'
              }))
            }
          );
          return;
        }
      } catch (error) {
        console.error('Failed to load sheets:', error);
        addBotMessage('Failed to load sheets from this spreadsheet.', false);
        setLoading(false);
        return;
      }
    }

    // Handle vector databases (LanceDB and Pinecone)
    const isVectorDB = selConn?.dbCategory === 'Vector' || selConn?.dbType === 'lancedb' || selConn?.dbType === 'pinecone';

    if (isVectorDB) {
      // For vector databases, load schema from the database
      setLoading(true);
      await loadVectorTableSchema(selectedTable);
      setLoading(false);

      addBotMessage(
        `Table "${selectedTable.name}" selected. Configuration complete! Click Save below.`,
        false
      );
      setSaveState(true); // Enable save button
      return;
    }

    // Generate a basic query for preview based on database type
    const isMongoDB = selConn?.dbType === 'mongodb';
    let previewQuery;

    if (isMongoDB) {
      // MongoDB JSON query
      previewQuery = JSON.stringify({
        collection: selectedTable.name,
        filter: {},
        limit: 100
      });
    } else {
      // SQL query - use database-specific identifier quoting
      const quotedResult = await window.electronAPI.dbConnect.quoteIdentifier(
        selConn.dbType,
        selectedTable.name,
        selectedTable.schema,
        selConn.dbConfig,
        selConn.id
      );
      const fullTableName = quotedResult.quotedIdentifier;

      // Use database-specific preview query syntax
      const previewResult = await window.electronAPI.dbConnect.getPreviewQuery(
        selConn.dbType,
        fullTableName,
        100
      );
      previewQuery = previewResult.previewQuery;
    }

    // Load table schema with columns and sample data
    await loadTableSchemaFromDB(selectedTable);

    // Store the query for preview
    setLatestWithSQL({
      sql: previewQuery,
      previewSql: previewQuery,
      explanation: `Selecting all columns from ${selectedTable.schema ? `${selectedTable.schema}.${selectedTable.name}` : selectedTable.name}`,
      queryDescription: `Preview data from ${selectedTable.name}`
    });

    addBotMessage(
      `Table "${selectedTable.schema ? `${selectedTable.schema}.${selectedTable.name}` : selectedTable.name}" selected. Configuration complete! Click Save below.`,
      false
    );

    setSaveState(true); // Enable save button
  };

  // ─────────────────────────────────────────────────────────────────────────
  // Sheet Selection (for Google Sheets)
  // ─────────────────────────────────────────────────────────────────────────

  const handleSheetSelection = async (userMsg) => {
    const sheetData = userMsg.data; // Contains spreadsheet info + selected sheet
    const { name: spreadsheetId, displayName, sheetName } = sheetData;

    setLoading(true);

    try {
      addBotMessage(`Importing sheet "${sheetName}" from "${displayName}"...`, false);

      // Import the Google Sheet to SQLite
      const importResult = await window.electronAPI.dbConnect.importGoogleSheetToSqlite(
        selConn.dbConfig,
        selConn.id,
        spreadsheetId,
        sheetName
      );

      if (!importResult.success) {
        addBotMessage(`Failed to import sheet: ${importResult.message}`, false);
        setLoading(false);
        return;
      }

      console.log('Import result:', importResult);

      // Update the connection to point to the imported SQLite file
      const actualFileName = 'app-data.db'; // This is hardcoded in the plugin

      const localConnection = {
        ...selConn,
        connectionType: 'file',
        fileType: 'sqlite',
        dbType: 'sqlite',
        dbConfig: {},
        fileInfo: {
          filePath: importResult.localPath,
          fileName: actualFileName, // Use actual file name from the path
          dbType: 'sqlite',
          tables: [importResult.tableName],
          source: 'google-sheets',
          originalSpreadsheetId: spreadsheetId,
          originalSpreadsheetName: displayName,
          originalSheetName: sheetName
        },
        // Keep the original Google Sheets connection info for reference
        _googleSheetsSource: {
          spreadsheetId,
          spreadsheetName: displayName,
          sheetName
        }
      };

      setSelConn(localConnection);

      // Update selected tables to use the imported SQLite table name
      setAiSelectedTables([importResult.tableName]);

      // Load schema from the imported SQLite table
      const schema = await loadTableSchema({
        connection: { dbType: 'sqlite', dbConfig: {} },
        tableName: importResult.tableName,
        tableSchema: null,
        localPath: importResult.localPath,
        limit: 5
      });

      if (schema) {
        setTableSchema(schema);
      }

      // Generate preview query for the SQLite table
      const previewResult = await window.electronAPI.dbConnect.getPreviewQuery(
        'sqlite',
        `"${importResult.tableName}"`,
        100
      );
      const previewQuery = previewResult.success ? previewResult.previewQuery : `SELECT * FROM "${importResult.tableName}" LIMIT 100`;

      // Store the query for preview
      setLatestWithSQL({
        sql: previewQuery,
        previewSql: previewQuery,
        explanation: `Selecting all columns from ${importResult.tableName}`,
        queryDescription: `Preview data from ${sheetName}`
      });

      addBotMessage(
        `Sheet "${sheetName}" from "${displayName}" imported successfully! ${importResult.rowCount} rows imported. Configuration complete! Click Save below.`,
        false
      );

      setSaveState(true); // Enable save button
      setLoading(false);
    } catch (error) {
      console.error('Failed to import Google Sheet:', error);
      addBotMessage('Failed to import Google Sheet. Please try again.', false);
      setLoading(false);
    }
  };

  // ─────────────────────────────────────────────────────────────────────────
  // Load Table Schema (columns and sample data)
  // ─────────────────────────────────────────────────────────────────────────

  const loadTableSchemaFromDB = async (selectedTable, connection = null, sheetName = null) => {
    try {
      // Use provided connection or fall back to selConn
      const conn = connection || selConn;

      // First check if schema is already saved in fileInfo
      if (conn.fileInfo?.schemas) {
        let savedSchema = null;

        // Handle both single schema object and schemas array
        if (Array.isArray(conn.fileInfo.schemas)) {
          // Multiple schemas (e.g., Excel with multiple sheets)
          savedSchema = conn.fileInfo.schemas.find(s => s.tableName === selectedTable.name);
        } else if (conn.fileInfo.schemas.tableName) {
          // Single schema object
          if (conn.fileInfo.schemas.tableName === selectedTable.name) {
            savedSchema = conn.fileInfo.schemas;
          }
        }

        if (savedSchema) {
          setTableSchema(savedSchema);
          console.log('Using saved schema from fileInfo:', savedSchema);
          return;
        }
      }

      // Fallback: Load table schema from DB if not found in fileInfo
      // For file-based connections, pass the local file path
      const localPath = conn.connectionType === 'file' ? conn.fileInfo?.filePath : null;

      const schema = await loadTableSchema({
        connection: conn,
        tableName: selectedTable.name,
        tableSchema: selectedTable.schema,
        localPath: localPath,
        sheetName: sheetName // Pass sheet name for Google Sheets
      });

      if (schema) {
        setTableSchema(schema);
        console.log('Loaded table schema from DB:', schema);
      }
    } catch (error) {
      console.error('Failed to load table schema:', error);
    }
  };

  // ─────────────────────────────────────────────────────────────────────────
  // Load Vector Database Schema (LanceDB and Pinecone)
  // ─────────────────────────────────────────────────────────────────────────

  const loadVectorTableSchema = async (selectedTable) => {
    try {
      const dbType = selConn.dbType;
      const tableName = selectedTable.name;

      // Use vector DB skill to query for preview
      const result = await window.electronAPI.skills.queryVectorPreview({
        vectorDbType: dbType,
        tableName: tableName,
        namespace: selectedTable.schema || '',
        dbConfig: selConn.dbConfig || {},
        connectionId: selConn.id,
        targetLocalPath: selConn.localPath || selConn.fileInfo?.filePath
      });

      if (result.success && result.data && result.data.length > 0) {
        // Infer schema from first record
        const sampleRecord = result.data[0];
        const columns = Object.keys(sampleRecord).map(key => ({
          name: key,
          type: inferColumnType(sampleRecord[key]),
          nullable: true
        }));

        const schema = {
          tableName: tableName,
          columns: columns,
          sampleData: result.data.slice(0, 5), // First 5 records
          recordCount: result.totalRows || result.recordCount
        };

        setTableSchema(schema);
        console.log('Loaded vector database schema:', schema);
      } else {
        console.warn('No data returned from vector database preview');
      }
    } catch (error) {
      console.error('Failed to load vector table schema:', error);
    }
  };

  // Helper function to infer column type from value
  const inferColumnType = (value) => {
    if (value === null || value === undefined) return 'string';
    if (typeof value === 'number') return 'number';
    if (typeof value === 'boolean') return 'boolean';
    if (Array.isArray(value)) return 'array';
    if (typeof value === 'string' && value.includes('[') && value.includes('dims]')) {
      return 'vector'; // Vector field (compacted representation)
    }
    return 'string';
  };

  // ─────────────────────────────────────────────────────────────────────────
  // Database Operations
  // ─────────────────────────────────────────────────────────────────────────

  const loadConnections = async () => {
    setLoading(true);
    try {
      const token = localStorage.getItem('auth-token');
      let conns = [];
      // if (!token) {
        conns = await connectionsDb.getAll();
      // } else {
      //   const res = await axios.post('/workflow/connections', { transformer: false }, {
      //     headers: { 'auth-token': token },
      //   });
      //   if (res.data.success) conns = res.data.data;
      // }

      // Load plugins to get dbCategory for each connection
      let pluginsMap = new Map();
      if (window.electronAPI?.dbConnect?.listPlugins) {
        try {
          const pluginsResult = await window.electronAPI.dbConnect.listPlugins();
          if (pluginsResult.success && pluginsResult.connectors) {
            pluginsResult.connectors.forEach(plugin => {
              pluginsMap.set(plugin.id, plugin);
            });
          }
        } catch (error) {
          console.error('Failed to load plugins:', error);
        }
      }

      // Enrich connections with plugin metadata
      const enrichedConnections = conns.map(conn => {
        const plugin = pluginsMap.get(conn.dbType);
        return {
          ...conn,
          dbCategory: plugin?.dbCategory || null,
          storageType: plugin?.storageType || null
        };
      });

      setConnections(enrichedConnections);
    } catch (err) {
      console.error('Failed to load connections', err);
    } finally {
      setLoading(false);
    }
  };

  const handleConnectionTypeSelectorClose = () => {
    setIsConnectionTypeSelectorOpen(false);
    // Refresh connections list in case new ones were added
    loadConnections();
  };

  // Handle connection type selection
  const handleConnectionTypeSelect = (type) => {
    setIsConnectionTypeSelectorOpen(false);
    setActiveDbType(type);
  };

  // Test connection handler
  const handleTestConnection = async (dbType, config) => {
    let result;

    // Prefer direct Electron IPC (no backend required)
    if (window.electronAPI?.dbConnect) {
      result = await window.electronAPI.dbConnect.test(dbType, config);
    } else {
      const token = localStorage.getItem('auth-token');
      if (!token) {
        result = { success: false, message: 'Sign in or use the desktop app to test live database connections.' };
      } else {
        try {
          const response = await axios.post('/workflow/test-connection', { dbType, config }, {
            headers: { 'auth-token': token },
          });
          result = response.data.success
            ? { success: true, message: response.data.message || 'Connection successful!' }
            : { success: false, message: response.data.error || 'Connection failed.' };
        } catch (err) {
          result = { success: false, message: err.response?.data?.error || 'Connection failed. Check your credentials.' };
        }
      }
    }

    if (result.success) {
      antdMessage.success(result.message || 'Connection successful!');
    } else {
      antdMessage.error(result.message || 'Connection failed.');
    }

    return result;
  };

  // Save connection handler
  const handleSaveDbConnection = async (connectionData) => {
    const token = localStorage.getItem('auth-token');
    const isFileConnection = connectionData.connectionType === 'file';

    if (!token || isFileConnection) {
      try {
        // For database connections, separate sensitive credentials from connection data
        if (connectionData.connectionType === 'database' && connectionData.dbConfig && window.electronAPI?.dbCredentials) {
          const { dbConfig, ...connectionDataWithoutConfig } = connectionData;

          let sensitiveFields = {};
          let nonSensitiveConfig = {};

          // Get the plugin's config schema to determine which fields are sensitive
          const plugin = installedPlugins.find(p => p.id === connectionData.dbType);
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

          const saved = await connectionsDb.save(safeConnectionData);
          // Save credentials separately (encrypted) using the new connection ID
          await window.electronAPI.dbCredentials.save(saved.id, sensitiveFields);

          antdMessage.success('Connection saved securely.');
          setActiveDbType(null);
          loadConnections();
        } else {
          // Non-database connections (file, API) - save as-is
          await connectionsDb.save(connectionData);
          antdMessage.success('Connection saved.');
          setActiveDbType(null);
          loadConnections();
        }
      } catch (error) {
        console.error('Error saving connection:', error);
        antdMessage.error('Failed to save connection.');
      }
      return;
    }

    try {
      const payload = { ...connectionData, status: 'untested' };
      const response = await axios.post('/workflow/connection-save', payload, {
        headers: { 'auth-token': token },
      });
      if (response.data.success) {
        loadConnections();
        setActiveDbType(null);
        antdMessage.success('Connection saved.');
      } else {
        antdMessage.error(response.data.error || 'Failed to save connection.');
      }
    } catch (err) {
      antdMessage.error('Failed to save connection.');
    }
  };

  // Get modal title for connection type
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

  // Get active form component based on connection type
  const getActiveFormComponent = () => {
    if (!activeDbType) return null;

    // Local file connections (sqlite, nedb, json, spreadsheet, parquet, avro)
    if (['sqlite', 'nedb', 'json', 'spreadsheet', 'parquet', 'avro'].includes(activeDbType)) {
      return () => (
        <LocalFileConnectionForm
          fileType={activeDbType}
          onSave={handleSaveDbConnection}
          onCancel={() => setActiveDbType(null)}
          editingConnection={null}
        />
      );
    }

    // Database connectors use dynamic form based on plugin
    const plugin = installedPlugins.find(p => p.id === activeDbType);
    if (plugin) {
      return () => (
        <DynamicConnectionForm
          plugin={plugin}
          onSave={handleSaveDbConnection}
          onCancel={() => setActiveDbType(null)}
          onTest={handleTestConnection}
          editingConnection={null}
        />
      );
    }

    return null;
  };

  const ActiveForm = getActiveFormComponent();

  const loadDatabaseTables = async (conn, silent = false) => {
    setLoading(true);
    try {
      const result = await onLoadDatabaseTables(conn);
      
      if (result.success) {
        let tableList = result.tables || [];

        // Filter tables for file-based connections to only show tables from this specific upload
        if (conn.connectionType === 'file' && conn.fileInfo?.tables && conn.fileInfo.tables.length > 0) {
          // Only show tables that belong to this connection
          const connectionTables = conn.fileInfo.tables;
          tableList = tableList.filter(t => {
            const tableName = t.name || String(t);
            return connectionTables.includes(tableName);
          });
        }

        // Store full table objects with schema information
        const tableObjects = tableList.map(t => ({
          name: t.name || String(t),
          schema: t.schema || null,
          displayName: t.displayName || null,
          type: t.type || null
        }));
        setDbTableObjects(tableObjects);

        // Extract just the table names for AI processing
        const tableNames = tableObjects.map(t => t.name);
        setDbTables(tableNames);

        // Only add messages if not in silent mode (when restoring state)
        if (!silent) {
          if (tableNames.length > 0) {
            addBotMessage(
              `Connected! Found ${tableNames.length} table${tableNames.length !== 1 ? 's' : ''} in "${conn.name}".\n\nYou can view the schema in the Data Preview panel below.`,
              false
            );
            addBotMessage(
              'Which table would you like to use?',
              true,
              'choice',
              'tableSelection',
              '',
              {
                choices: tableObjects.map(table => {
                  // Use displayName if available (for services like Google Sheets)
                  const displayText = table.displayName || table.name;
                  return {
                    label: table.schema ? `${table.schema}.${displayText}` : displayText,
                    value: table.name,
                    description: table.schema || '',
                    _data: table,
                    displayType: 'dropdown'
                  };
                })
              }
            );
          } else {
            addBotMessage('No tables found. Make sure the connection is configured correctly.', false);
          }
        }
      } else {
        console.log('Failed to load tables: ', result)
        if (!silent) {
          addBotMessage('Failed to load tables. Please check the connection settings.', false);
        }
      }
    } catch (err) {
      console.error('Failed to load tables:', err);
      if (!silent) {
        addBotMessage('Failed to load tables. Please check the connection settings.', false);
      }
    } finally {
      setLoading(false);
    }
  };

  // ─────────────────────────────────────────────────────────────────────────
  // AI Database Query Handler (handles all database user inputs)
  // ─────────────────────────────────────────────────────────────────────────

  // const handleDatabaseQuery = async (userMsg, databaseType) => {
  //   setAiLoading(true);
  //   setLoading(true);
  //   const schemas = {};
  //   const targetSchema = selConn?.dbConfig?.schema;
  //   const fullTableName = `${targetSchema}.${node.id.replace('-', '_').toLowerCase()}`;

  //   // Build chat history for AI context (excluding the current message)
  //   const chatHistory = chat.slice(0, -1).map(msg => ({
  //     sender: msg.sender,
  //     text: msg.text
  //   }));
  //   console.log('dbTables: ', dbTables)
  //   try {
  //     // Step 1: If first query, analyze which tables are needed
  //     if (aiSelectedTables.length === 0) {
  //       const tableListText = dbTables.join(', ');
  //       // Get schema from connection config

  //       // Use appropriate terminology based on database type
  //       const entityName = databaseType === 'mongodb' ? 'collections' : 'tables';
  //       const queryType = databaseType === 'mongodb' ? 'query' : 'SQL';

  //       const analysisPrompt = `
  //       You are helping query a ${databaseType === 'mongodb' ? 'MongoDB database' : 'database'}.

  //       User request:
  //       "${userMsg.text}"

  //       Available ${entityName}:
  //       ${tableListText}

  //       Your task:
  //       Decide whether to answer the question directly (if it is not ${queryType}-related) or request the relevant ${entityName} so you can retrieve their schema for a follow-up ${queryType} generation step.

  //       You must return one of these two JSON formats:

  //       1. If no ${queryType} is required:
  //       {"response": "Direct response to the question"}

  //       2. If schema details are required before writing ${queryType}:
  //       {"tables": ["Exact ${entityName.slice(0, -1)} names from the provided list that are relevant to the user's request"]}
  //       `;
  //       //         Target schema: ${targetSchema}
  //       // Target table name for results: ${fullTableName}
  //       //         2. Direct answer with SQL (for simple queries that do not require schema inspection):
  //       // {"explanation": "Brief explanation of what the query does",
  //       // "ddl": "CREATE TABLE ${fullTableName} statement to store the results, using ${databaseType} syntax",
  //       // "sql": "INSERT INTO ${fullTableName} statement to populate the table, using ${databaseType} syntax"}

  //       const response = await getWorkflowAssistance('tableSelection', analysisPrompt, { dbTables }, chatHistory);
  //       console.log('response: ', response)
  //       // Store the analysis context for later SQL generation
  //       setTableAnalysisContext({
  //         prompt: analysisPrompt,
  //         response: response
  //       });

  //       let selectedTables = {};
  //       try {
  //           selectedTables = JSON.parse(response);
  //       } catch (e) {
  //         selectedTables = dbTables;
  //       }

  //       if(selectedTables.sql){
  //         setSaveState(true)
  //         // Generate preview SQL/query locally based on database type
  //         let previewSql;
  //         if (databaseType === 'mongodb') {
  //           // For MongoDB, use the same query as the main query
  //           previewSql = selectedTables.sql;
  //         } else {
  //           // For SQL databases, generate SELECT statement
  //           previewSql = `SELECT * FROM ${fullTableName} LIMIT 100`;
  //         }

  //         // Direct SQL response - save it to latestWithSQL
  //         setLatestWithSQL({
  //           ddl: selectedTables.ddl || '',
  //           sql: selectedTables.sql,
  //           previewSql: previewSql,
  //           explanation: selectedTables.explanation || '',
  //           queryDescription: userMsg.text
  //         });

  //         // Store SQL in user message
  //         setChat(prev => prev.map(msg => {
  //           if (msg.id === userMsg.id) {
  //             return {
  //               ...msg,
  //               ddl: selectedTables.ddl || '',
  //               sql: selectedTables.sql,
  //               previewSql: previewSql,
  //               explanation: selectedTables.explanation
  //             };
  //           }
  //           return msg;
  //         }));

  //         // Add bot message with SQL in metadata
  //         const botMessage = selectedTables.explanation || 'Here\'s the SQL query:';
  //         addBotMessage(botMessage, false, 'text', '', '', {
  //           ddl: selectedTables.ddl || '',
  //           sql: selectedTables.sql,
  //           previewSql: previewSql
  //         });
  //         addBotMessage(
  //           'You can ask follow-up questions to refine this query, or click Save when ready.',
  //           true,
  //           'text',
  //           'databaseQuery',
  //           'Ask a follow-up question or request changes…'
  //         );
  //         return;
  //       }

  //       if(selectedTables.response){
  //         addBotMessage(selectedTables.response, false);
  //         addBotMessage(
  //           'You can ask follow-up questions, or click Save when ready.',
  //           true,
  //           'text',
  //           'databaseQuery',
  //           'Ask a follow-up question…'
  //         );
  //         return;
  //       }

  //       if(selectedTables.explanation){
  //         addBotMessage(selectedTables.explanation, false);
  //         addBotMessage(
  //           'You can ask follow-up questions, or click Save when ready.',
  //           true,
  //           'text',
  //           'databaseQuery',
  //           'Ask a follow-up question…'
  //         );
  //         return;
  //       }

  //       // selectedTables.tables contains the array of table names
  //       const tableArray = selectedTables.tables || selectedTables;
  //       selectedTables = Array.isArray(tableArray) ? tableArray.filter(t => dbTables.includes(t)) : dbTables;

  //       const entitySingular = databaseType === 'mongodb' ? 'collection' : 'table';

  //       if (selectedTables.length === 0){
  //         addBotMessage(
  //           `No ${entityName} found based on your request.`,
  //           true
  //         );
  //         return;
  //       }

  //       setAiSelectedTables(selectedTables);

  //       addBotMessage(
  //         `I'll use ${selectedTables.length === 1 ? `this ${entitySingular}` : `these ${entityName}`}: **${selectedTables.join(', ')}**`,
  //         false
  //       );

  //       // Step 2: Load sample data (100 distinct records) and column metadata for selected tables
  //       let totalRows = 0;
  //       const columnMetadata = {}; // Store column info with data types

  //       for (const tableName of selectedTables) {
  //         if (window.electronAPI?.dbConnect && selConn) {
  //           // Find the table object to get its schema
  //           const tableObj = dbTableObjects.find(t => t.name === tableName);
  //           const tableSchema = tableObj?.schema || null;

  //           // Fetch column metadata (including data types)
  //           const columnsResult = await window.electronAPI.dbConnect.getColumns(
  //             selConn.dbType,
  //             selConn.dbConfig,
  //             tableSchema,
  //             tableName,
  //             selConn.id
  //           );

  //           if (columnsResult.success && columnsResult.columns) {
  //             columnMetadata[tableName] = columnsResult.columns;
  //           }

  //           // Build query to get 100 distinct records
  //           let query;
  //           if (selConn.dbType === 'mongodb') {
  //             // For MongoDB, use JSON query format
  //             query = JSON.stringify({
  //               collection: tableName,
  //               filter: {},
  //               limit: 100
  //             });
  //           } else {
  //             // For SQL databases, use SELECT statement
  //             const fullTableName = tableSchema ? `${tableSchema}.${tableName}` : tableName;
  //             query = `SELECT DISTINCT * FROM ${fullTableName} LIMIT 100`;
  //           }

  //           const result = await window.electronAPI.dbConnect.runQuery(
  //             selConn.dbType,
  //             selConn.dbConfig,
  //             query,
  //             selConn.id
  //           );

  //           if (result.success && result.rows) {
  //             // Trim long text fields in the sample data
  //             const trimmedRows = result.rows.map(row => {
  //               const trimmedRow = {};
  //               Object.keys(row).forEach(key => {
  //                 const value = row[key];
  //                 if (typeof value === 'string' && value.length > 100) {
  //                   trimmedRow[key] = value.substring(0, 100) + '...';
  //                 } else {
  //                   trimmedRow[key] = value;
  //                 }
  //               });
  //               return trimmedRow;
  //             });

  //             schemas[tableName] = { rows: trimmedRows, columns: columnMetadata[tableName] || [] };
  //             totalRows += trimmedRows.length;
  //           }
  //         }
  //       }

  //       setSelectedTableSchemas(schemas);

  //       // addBotMessage(
  //       //   `Analyzing ${selectedTables.length} table${selectedTables.length !== 1 ? 's' : ''} (${totalRows} sample records)...`,
  //       //   false
  //       // );
  //     }

  //     // Step 3: Generate/refine SQL with sample data context
  //     const context = {
  //       dbType: selConn?.dbType,
  //       connectionName: selConn?.name,
  //       selectedTables: aiSelectedTables,
  //       tableSchemas: {}
  //     };
  //     // Include sample data and column metadata for each table (first 5 rows as examples)
  //     Object.entries(schemas).forEach(([tableName, data]) => {
  //       if (data && data.rows && data.rows.length > 0) {
  //         // Take first 5 rows as examples
  //         const sampleRows = data.rows.slice(0, 5);

  //         // Build columns array with name and type
  //         const columnsWithTypes = data.columns && data.columns.length > 0
  //           ? data.columns.map(col => ({
  //               name: col.name,
  //               type: col.type,
  //               nullable: col.nullable
  //             }))
  //           : Object.keys(data.rows[0]).map(colName => ({ name: colName, type: 'unknown' }));

  //         context.tableSchemas[tableName] = {
  //           columns: columnsWithTypes,
  //           sampleData: sampleRows
  //         };
  //       }
  //     });
  //     // console.log('schemas: ', schemas)
  //     // console.log('context.tableSchemas: ', context.tableSchemas)


  //     // Add table analysis context to chat history if available
  //     if (tableAnalysisContext) {
  //       chatHistory.unshift(
  //         { sender: 'user', text: tableAnalysisContext.prompt },
  //         { sender: 'bot', text: tableAnalysisContext.response }
  //       );
  //     }



  //     // Build prompt dynamically based on database type and processing environment
  //     let getSQL;

  //     if (databaseType === 'mongodb') {
  //       if (processingEnvironment === 'local') {
  //         // MongoDB local processing - generate JavaScript function
  //         getSQL = ChatPrompts.datasource.mongodb_local(userMsg, context)
  //       } else {
  //         // MongoDB database processing
  //         getSQL = ChatPrompts.datasource.mongodb_cloud(userMsg, context)
  //       }
  //     } else {
  //       // SQL databases
  //       if (processingEnvironment === 'local') {
  //         // SQL local processing - use SQLite DDL and SELECT with OFFSET
  //         getSQL = ChatPrompts.datasource.sql_local(userMsg, databaseType, context, node)
  //       } else {
  //         // SQL database processing
  //         getSQL = ChatPrompts.datasource.sql_cloud(userMsg, databaseType, targetSchema, fullTableName, context)
  //       }
  //     }

  //     const response = await getWorkflowAssistance('getSQL', getSQL, context, chatHistory);
  //     console.log('getSQL: ', response)
  //     // Try to parse JSON response first
  //     let parsedResponse;
  //     try {
  //       parsedResponse = JSON.parse(response);
  //     } catch (e) {
  //       // Fallback to old extraction method if JSON parsing fails
  //       const sql = extractSQL(response);
  //       const explanation = response.replace(/```(?:sql)?\s*[\s\S]*?```/g, '').trim();
  //       parsedResponse = {
  //         ddl: '',
  //         sql: sql,
  //         explanation: explanation
  //       };
  //     }

  //     const ddl = parsedResponse.ddl || '';
  //     const sql = parsedResponse.sql;

  //     // Generate preview SQL/query locally based on database type
  //     let previewSql;
  //     if (databaseType === 'mongodb') {
  //       // For MongoDB, use the same query as the main query (it already has limit)
  //       previewSql = sql;
  //     } else {
  //       // For SQL databases, generate SELECT statement
  //       previewSql = `SELECT * FROM ${fullTableName} LIMIT 100`;
  //     }

  //     const explanation = parsedResponse.explanation || '';

  //     if (sql) {
  //       setSaveState(true)
  //       // Update latestWithSQL state
  //       setLatestWithSQL({
  //         ddl,
  //         sql,
  //         previewSql,
  //         explanation,
  //         queryDescription: userMsg.text
  //       });

  //       // Store SQL in this user message
  //       setChat(prev => prev.map(msg => {
  //         if (msg.id === userMsg.id) {
  //           return { ...msg, ddl, sql, previewSql, explanation };
  //         }
  //         return msg;
  //       }));

  //       // Add bot message with SQL in metadata
  //       addBotMessage(explanation, false, 'text', '', '', {
  //         ddl: ddl,
  //         sql: sql,
  //         previewSql: previewSql
  //       });
  //     } else {
  //       addBotMessage(explanation, false);
  //     }
  //     addBotMessage(
  //       'You can ask follow-up questions to refine this query, or click Save when ready.',
  //       true,
  //       'text',
  //       'databaseQuery',
  //       'Ask a follow-up question or request changes…'
  //     );

  //   } catch (error) {
  //     console.error('Database query error:', error);
  //     addBotMessage('Failed to process query. Please try again.', false);
  //   } finally {
  //     setAiLoading(false);
  //     setLoading(false);
  //   }
  // };

  // ─────────────────────────────────────────────────────────────────────────
  // Build Configuration
  // ─────────────────────────────────────────────────────────────────────────
  // console.log('chat: ', chat, aiSelectedTables)
  const buildConfig = (apiFetchOverride = null) => {
    const config = {};

    // Use selConn (which may have been updated after Google Sheets import)
    // instead of chat history to handle cases where connection was converted to SQLite
    const conn = selConn;
    console.log('buildConfig: ', conn)
    if (conn) {
      config.nodeType = 'datasource'
      config.sourceConnectionId = conn.id;
      config.sourceConnectionName = conn.name;
      config.sourceConnectionType = conn.connectionType || 'file';
      config.sourceType = conn.fileType || conn.apiType || conn.dbType;

      // REST API sources materialise into local NeDB and behave like any
      // other NoSQL local source for downstream nodes.
      if (conn.dbType === 'rest-api') {
        // Prefer the override (fresh result from runAndSaveApiFetch) over
        // state, which may not have flushed yet when called synchronously
        // after setApiFetchResult(...).
        const fetchResult = apiFetchOverride || apiFetchResult;

        config.sourceConnectionType = 'api';
        config.sourceDbType = 'nedb';
        config.sourceDbCategory = 'API';

        // Point downstream at the same connection identifier used for other
        // local NeDB imports so DataPreview / Joins can route correctly.
        config.sourceApiConnectionId = conn.id;
        config.sourceApiConnectionName = conn.name;
        config.sourceConnectionId = 'local-nedb';

        const collection = fetchResult?.collection || sanitizeCollectionName(node?.data?.label || node?.id);
        config.sourceCollection = collection;
        config.sourceDataset = collection;
        // The NeDB file is always written by the main process; persist its
        // path so downstream nodes can read the materialised collection
        // without needing to re-run the fetch.
        config.sourceLocalPath = fetchResult?.localPath || null;

        // Fetch function — persisted so every workflow run can re-execute it.
        config.apiFetchPrompt = apiFetchPrompt || null;
        config.apiFetchExplanation = apiFetchExplanation || '';
        config.apiFetchCode = apiFetchCode || '';

        // Snapshot the public connection config so the chat can restore
        // enough context on reopen to let the user refine the request without
        // needing a live lookup of the connection.
        config.apiConnectionPublicConfig = {
          baseUrl: conn.dbConfig?.baseUrl || '',
          authType: conn.dbConfig?.authType || 'none',
          apiKeyName: conn.dbConfig?.apiKeyName || '',
          basicUser: conn.dbConfig?.basicUser || '',
        };

        return config;
      }

      // For file-based connections (SQLite, NeDB, spreadsheets, JSON)
      if (conn.connectionType === 'file') {
        config.sourceDataset = conn.name;

        // Add local file path information (SOURCE)
        if (conn.fileInfo?.filePath) {
          config.sourceLocalPath = conn.fileInfo.filePath;
        }

        // Add cloud source information if this file came from cloud storage
        if (conn.cloudSource) {
          config.cloudSource = conn.cloudSource;
        }

        // For SQLite, NeDB, and LanceDB, set appropriate dbType
        if (conn.dbType === 'sqlite' || conn.dbType === 'nedb' || conn.dbType === 'lancedb') {
          config.sourceDbType = conn.dbType;
          config.sourceDbCategory = conn.dbCategory || (conn.dbType === 'lancedb' ? 'Vector' : null);

          // For SQLite, set source table name
          if (conn.dbType === 'sqlite' && aiSelectedTables.length > 0) {
            config.sourceTableName = aiSelectedTables[0];
          }

          // For NeDB, set source collection name
          if (conn.dbType === 'nedb' && aiSelectedTables.length > 0) {
            config.sourceCollection = aiSelectedTables[0];
          }

          // For LanceDB, set source index name (table name)
          if (conn.dbType === 'lancedb' && aiSelectedTables.length > 0) {
            config.sourceIndexName = aiSelectedTables[0];
            config.sourceTableName = aiSelectedTables[0];
            config.sourceNamespace = ''; // LanceDB doesn't use namespaces
          }

          // Store table schema if available
          if (tableSchema) {
            config.sourceTableSchema = tableSchema;
          }
        }

        // Store preview query for SQLite
        if (conn.dbType === 'sqlite' && latestWithSQL) {
          config.sourceSql = latestWithSQL.sql;
          config.sourcePreviewSql = latestWithSQL.previewSql;
          config.sourceSqlExplanation = latestWithSQL.explanation || '';
        }
      } else if (conn.connectionType !== 'database') {
        // For other non-database connections (API, etc.)
        config.sourceDataset = conn.name;
      }
      // console.log('buildConfig: ', conn)
      if (conn.connectionType === 'database') {
        config.sourceDbType = conn.dbType;
        config.sourceDbCategory = conn.dbCategory;
        config.sourceDbConfig = conn.dbConfig;
        config.sourceSelectedTables = aiSelectedTables;

        // Store the selected table(s) for use in the workflow
        if (aiSelectedTables.length > 0) {
          config.sourceTable = aiSelectedTables[0]; // Primary selected table (deprecated, use sourceTableName)
        }

        // Get the selected table's schema from the table selection message
        const tableSelectionMsg = chat.slice().reverse().find(m => m.ref === 'tableSelection' && m.sender === 'user');
        const selectedTableData = tableSelectionMsg?.data;

        // Set source table/collection name
        const isNoSQL = conn.dbType === 'mongodb' || conn.dbType === 'nedb';
        const isVector = conn.dbCategory === 'Vector' || conn.dbType === 'pinecone' || conn.dbType === 'lancedb';

        if (isVector) {
          // For Vector databases, set sourceIndexName and sourceNamespace
          if (aiSelectedTables.length > 0) {
            const selectedTable = aiSelectedTables[0];

            if (conn.dbType === 'pinecone') {
              // Pinecone: parse index/namespace if format is "index/namespace"
              if (selectedTable.includes('/')) {
                const parts = selectedTable.split('/');
                config.sourceIndexName = parts[0];
                config.sourceNamespace = parts.slice(1).join('/');
              } else {
                config.sourceIndexName = selectedTable;
                config.sourceNamespace = selectedTableData?.namespace || '';
              }
              // Also set sourceTableName for compatibility with other parts of the system
              config.sourceTableName = config.sourceIndexName;
              config.sourceSchema = config.sourceNamespace;
            } else if (conn.dbType === 'lancedb') {
              // LanceDB: table name only (no namespace concept)
              config.sourceIndexName = selectedTable;
              config.sourceTableName = selectedTable;
              config.sourceNamespace = '';
            }
          }
        } else if (isNoSQL) {
          // For NoSQL, set sourceCollection
          config.sourceCollection = aiSelectedTables.length > 0 ? aiSelectedTables[0] : null;
        } else {
          // For SQL, set sourceTableName and sourceSchema
          config.sourceTableName = aiSelectedTables.length > 0 ? aiSelectedTables[0] : null;
          // Use the schema from the selected table, not the connection's default schema
          config.sourceSchema = selectedTableData?.schema || conn.dbConfig?.schema;
        }
        // console.log('latestWithSQL: ', latestWithSQL)
        // Store the preview query
        if (latestWithSQL) {
          config.sourceSql = latestWithSQL.sql;
          config.sourcePreviewSql = latestWithSQL.previewSql;
          config.sourceSqlExplanation = latestWithSQL.explanation || '';
          config.sourceQueryDescription = latestWithSQL.queryDescription || '';
        }

        // Store the table schema (columns and sample data)
        if (tableSchema) {
          config.sourceTableSchema = tableSchema;
        }

    }
    }

    return config;
  };

  // ─────────────────────────────────────────────────────────────────────────
  // UI Helpers
  // ─────────────────────────────────────────────────────────────────────────

  const getCurrentQuestion = () => {
    for (let i = 0; i < chat.length; i++) {
      const msg = chat[i];
      if (msg.sender === 'bot' && msg.responseRequired) {
        const nextMsg = chat[i + 1];
        if (!nextMsg || nextMsg.sender !== 'user') {
          return msg;
        }
      }
    }
    return null;
  };

  const currentQ = getCurrentQuestion();

  const getChoices = () => {
    if (!currentQ) return [];

    // Only show connection choices if connection not yet selected
    if (!connectionComplete && currentQ.responseType === 'connection') {
      const categorize = (conn) => {
        if (conn.dbCategory === 'CloudStorage') return 'Cloud Storage';
        if (conn.dbCategory === 'API') return 'APIs';
        if (conn.connectionType === 'database') return 'Databases';
        if (conn.connectionType === 'file') return 'Local Files';
        return 'Other';
      };

      const groupColor = {
        'Cloud Storage': '#0891b2',
        'APIs': '#2563eb',
        'Databases': '#7c3aed',
        'Local Files': '#d97706',
        'Other': '#5a6678',
      };

      const connectionChoices = connections.map(conn => {
        const group = categorize(conn);
        return {
          label: conn.name,
          value: conn.id,
          description: conn.description,
          fullWidth: true,
          _data: conn,
          icon: getConnectionIcon(conn),
          group,
          groupColor: groupColor[group],
        };
      });

      // Keep the "New Connection" button at the top, outside of groups
      return [
        {
          label: 'New Connection',
          value: '__new_connection__',
          description: 'Create a new data source connection',
          fullWidth: true,
          variant: 'outlined',
          icon: <PlusOutlined style={{ fontSize: 16 }} />,
          _isNewConnection: true
        },
        ...connectionChoices
      ];
    }

    // Show table selection choices
    if (currentQ.responseType === 'choice' && currentQ.ref === 'tableSelection') {
      return currentQ.metadata?.choices || [];
    }

    // Show sheet selection choices (for Google Sheets)
    if (currentQ.responseType === 'choice' && currentQ.ref === 'sheetSelection') {
      return currentQ.metadata?.choices || [];
    }

    return [];
  };

  const getPlaceholder = () => {
    if (!currentQ) return '';
    return currentQ.placeholder || 'Type your response…';
  };

  const handleSendMessage = () => {
    const text = inputValue.trim();
    if (!text || !currentQ) return;
    setInputValue('');
    handleUserResponse(text, currentQ.ref, text, selectedChoice?._data);
  };

  const handleChoiceSelect = (choice) => {
    if (!currentQ) return;
    // console.log('choice: ', choice)
    setSelectedChoice(choice)
    handleUserResponse(choice.label, currentQ.ref, choice.value, choice._data);
  };

  const handleKeyPress = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage();
    }
  };

  const handleSave = async () => {
    setSaveState(false);

    // Save configuration
    const config = buildConfig();
    onSave(config, chat);
  };


  const displayChoices = () => {
    // Don't show choices while loading
    if (loading || aiLoading || executing || apiRunning) return [];

    // REST API: offer Run & Save only while there is a freshly generated
    // fetch function that has not yet been executed. Reopening a saved node
    // should not re-prompt the user to run unless they refine the request.
    if (selConn?.dbType === 'rest-api' && apiFetchCode && apiFetchDirty) {
      return [{
        label: 'Run & Save Configuration',
        value: 'run_save_api',
        variant: 'contained',
        fullWidth: true,
      }];
    }

    // Show Save when configuration is complete
    if (saveState) {
      return [{ label: 'Save Configuration', value: 'save', variant: 'contained', fullWidth: true }];
    }

    return getChoices();
  };

  const handleChoiceClick = (choice) => {
    if (choice.value === 'save') {
      handleSave();
    } else if (choice.value === 'run_save_api') {
      runAndSaveApiFetch();
    } else if (choice._isNewConnection) {
      // Open ConnectionTypeSelector modal
      setIsConnectionTypeSelectorOpen(true);
    } else {
      handleChoiceSelect(choice);
    }
  };

  const displayMessages = chat.map(m => ({
    id: m.id,
    text: m.text,
    metadata: m.metadata,
    sender: m.sender,
    timestamp: m.timestamp || new Date(),
  }));

  // ─────────────────────────────────────────────────────────────────────────
  // Code popup wiring — mapping from chat-message metadata field to node config
  // ─────────────────────────────────────────────────────────────────────────
  const handleCodeSave = useCallback((field, value, message) => {
    const updatedChat = chat.map(m =>
      m.id === message?.id
        ? { ...m, metadata: { ...m.metadata, [field]: value } }
        : m
    );
    setChat(updatedChat);

    if (field === 'sql') {
      setLatestWithSQL(prev => ({
        ...(prev || {}),
        sql: value,
        previewSql: value,
      }));
    }

    if (!onConfigUpdate || !node?.id) return;

    let update;
    switch (field) {
      case 'sql':
        update = { sourceSql: value, sourcePreviewSql: value };
        break;
      case 'ddl':
        update = { sourceDdl: value };
        break;
      case 'transformFunction':
        update = { transformFunction: value };
        break;
      case 'pythonCode':
        update = { pythonCode: value };
        break;
      case 'javascriptFunction':
        update = { javascriptFunction: value };
        break;
      default:
        update = { [field]: value };
    }
    onConfigUpdate(node.id, { ...update, chat: updatedChat });
  }, [onConfigUpdate, node?.id, chat]);

  // ─────────────────────────────────────────────────────────────────────────
  // Render
  // ─────────────────────────────────────────────────────────────────────────

  return (
    <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
      <ChatArea
          hideHeader
          isFullscreen={false}
          currentChatTitle=""
          multiStepData={null}
          handleFullscreen={() => {}}
          handleToggleChat={() => {}}
          chatContainerRef={chatContainerRef}
          messages={displayMessages}
          isLoading={loading || aiLoading}
          progressInfo={{ progress: 0, stage: (loading || aiLoading) ? 'Processing...' : '' }}
          messagesEndRef={messagesEndRef}
          inputRef={inputRef}
          inputValue={inputValue}
          setInputValue={setInputValue}
          handleKeyPress={handleKeyPress}
          handleSendMessage={handleSendMessage}
          formatTimestamp={formatTimestamp}
          onSaveToMain={null}
          choices={displayChoices()}
          onChoiceSelect={handleChoiceClick}
          inputPlaceholder={getPlaceholder()}
          disableInput={disableInput}
          showRunButton={false}
          onRun={null}
          runButtonLoading={false}
          onCodeSave={handleCodeSave}
        />

        {/* Cloud Storage Browser Modal */}
        {cloudStorageBrowserOpen && cloudStorageConnection && (
          cloudStorageConnection.dbType === 'google-drive' && cloudStorageConnection.dbConfig?.accessToken ? (
            // Google Drive with OAuth login - use Picker
            <GoogleDrivePicker
              connection={cloudStorageConnection}
              onFileSelect={handleCloudFileSelect}
              onClose={() => setCloudStorageBrowserOpen(false)}
            />
          ) : pluginManager ? (
            // Other cloud storage or Google Drive without OAuth - use browser
            <CloudStorageBrowser
              open={cloudStorageBrowserOpen}
              onClose={() => setCloudStorageBrowserOpen(false)}
              connection={cloudStorageConnection}
              onFileSelect={handleCloudFileSelect}
              pluginManager={pluginManager}
            />
          ) : null
        )}

        {/* Connection Type Selector Modal */}
        <ConnectionTypeSelector
          open={isConnectionTypeSelectorOpen}
          onClose={handleConnectionTypeSelectorClose}
          onSelectType={handleConnectionTypeSelect}
        />

        {/* Connection Form Modal */}
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
            }}
            footer={null}
            width={640}
            destroyOnClose
          >
            <ActiveForm />
          </Modal>
        )}
    </div>
  );
};

export default DataSourceNodeChat;
